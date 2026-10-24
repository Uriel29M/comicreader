export function createReaderFormats(deps) {
  const {
    $,
    READER_END_PAGE_URL,
    appAssetUrl,
    createArchivePageCache,
    deleteReaderFileCache,
    ensureReaderDependency,
    escapeHTML,
    fetchFileArrayBuffer,
    finishReaderPageLoading,
    getReaderPages,
    getReaderSpreadIndexes,
    getReaderSpreadPages,
    hasZipEndRecord,
    isInvalidZipError,
    isTelegramMediaUrl,
    isZipSignature,
    loadLibarchiveModule,
    proxiedFileUrl,
    readerEndPageImage,
    readerLoadingMarkup,
    readerLoadingTipMarkup,
    reportFileFailure,
    setReadingMode,
    showReaderPageLoading,
    state,
    waitForPrefetchedBuffer
  } = deps;

  async function fetchPdfBuffer(url, signal, onProgress = () => {}) {
    const source = proxiedFileUrl(url);
    let response;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        response = await fetch(source, {
          method: "GET",
          mode: "cors",
          credentials: "omit",
          cache: "no-store",
          priority: "high",
          signal
        });
      } catch (error) {
        if (signal?.aborted || attempt === 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
        continue;
      }
      if (response.ok) break;
      const retryable = [429, 502, 503, 504].includes(response.status);
      if (!retryable || attempt === 3) {
        const error = new Error(`Arquivo não encontrado (HTTP ${response.status})`);
        error.name = 'MissingPDFException';
        throw error;
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(10000, retryAfter * 1000)
        : 800 * (attempt + 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    const total = Number(response.headers.get("content-length")) || 0;
    if (!response.body?.getReader) return await response.arrayBuffer();
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      received += part.value.byteLength;
      onProgress(received, total);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; });
    return bytes.buffer;
  }

  async function renderPDFReader(item, url, body, controls, overlay, skipCover = false, resumePage = 1, onPageChange = () => {}, prefetchedBuffer = null) {
    body.innerHTML = readerLoadingMarkup("Carregando PDF…");
    try {
      const pdfjs = await (window.pdfjsReady || Promise.resolve(window.pdfjsLib));
      // PDF.js 4.x via module pode não expor global em alguns navegadores.
      if (!pdfjs?.getDocument) {
        throw Object.assign(new Error("PDF.js não está disponível nesta página."), { name: "PDFJS_MISSING" });
      }

      // Fetch Telegram PDFs ourselves and hand bytes to PDF.js. Some browsers
      // fail when the worker performs its own ranged requests against the Edge
      // Function, even though the endpoint returns a valid PDF.
      body.innerHTML = readerLoadingMarkup("Abrindo arquivo PDF…");
      let pdfData;
      let pdfUrl = null;
      if (prefetchedBuffer) {
        pdfData = await prefetchedBuffer;
      } else if (item.local && item.file) {
        pdfData = await item.file.arrayBuffer();
      } else if (isTelegramMediaUrl(url)) {
        const downloadController = new AbortController();
        overlay._pdfDownloadController = downloadController;
        const progressBar = body.querySelector(".reader-progress");
        const label = body.querySelector(".reader-loading-label");
        const detail = document.createElement("div");
        detail.className = "reader-loading-detail";
        body.querySelector(".reader-loading")?.appendChild(detail);
        pdfData = await fetchPdfBuffer(url, downloadController.signal, (received, total) => {
          if (label) label.textContent = "Carregando PDF…";
          if (!progressBar) return;
          if (total > 0) {
            progressBar.max = 100;
            progressBar.value = Math.min(100, Math.round((received / total) * 100));
            detail.textContent = `${(received / 1048576).toFixed(1)} MB de ${(total / 1048576).toFixed(1)} MB`;
          } else {
            progressBar.removeAttribute("value");
            detail.textContent = `${(received / 1048576).toFixed(1)} MB processados`;
          }
        });
      } else if (!prefetchedBuffer && !item.local) {
        // PDF.js busca somente os intervalos necessários para fontes comuns.
        pdfUrl = proxiedFileUrl(url);
      } else {
        pdfData = await fetchPdfBuffer(url, null);
      }
      if (pdfData && !pdfData.byteLength) throw new Error("PDF vazio.");

      // Pass the data as a typed array.
      body.innerHTML = readerLoadingMarkup("Abrindo PDF…");
      const loadingTask = pdfjs.getDocument(pdfUrl ? { url: pdfUrl } : { data: new Uint8Array(pdfData) });
      loadingTask.onProgress = ({ loaded, total }) => {
        const bar = body.querySelector(".reader-progress");
        if (!bar) return;
        if (total > 0 && loaded < total) {
          bar.max = total;
          bar.value = loaded;
        } else {
          bar.removeAttribute("value");
        }
      };
      const pdf = await loadingTask.promise;

      const currentReadingMode = state.readingMode;

      if (currentReadingMode === 'single-page') {
        const firstPage = skipCover && pdf.numPages > 1 ? 2 : 1;
        const totalPages = pdf.numPages + 1;
        let page = Math.max(firstPage, Math.min(resumePage, totalPages));
        let drawInProgress = false;
        const canvas = document.createElement("canvas");
        canvas.className = "reader-canvas";

        async function drawSinglePage() {
          if (drawInProgress) return;
          drawInProgress = true;
          try {
            if (page === totalPages) {
              body.replaceChildren(readerEndPageImage());
              controls.innerHTML = `<button data-prev>‹</button><span class="reader-page">${page} / ${totalPages}</span><button data-next disabled>›</button>`;
              $("[data-prev]", controls)?.addEventListener("click", async () => {
                if (drawInProgress || page <= firstPage) return;
                page--;
                await drawSinglePage();
              });
              onPageChange(item, page, totalPages);
              return;
            }
            const p = await pdf.getPage(page);
            const baseViewport = p.getViewport({ scale: 1 });
            const availableWidth = Math.max(240, body.clientWidth - 40);
            const availableHeight = Math.max(240, body.clientHeight - 40);
            const scale = Math.max(0.5, Math.min(2.2, availableWidth / baseViewport.width, availableHeight / baseViewport.height));
            const viewport = p.getViewport({ scale });
            const dpr = window.devicePixelRatio || 1;
            canvas.width = Math.floor(viewport.width * dpr);
            canvas.height = Math.floor(viewport.height * dpr);
            canvas.style.width = `${viewport.width}px`;
            canvas.style.height = `${viewport.height}px`;
            const ctx = canvas.getContext("2d", { alpha: false });
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            await p.render({ canvasContext: ctx, viewport }).promise;
            if (!canvas.isConnected) body.replaceChildren(canvas);
            controls.innerHTML = `
              <button data-prev ${page <= firstPage ? "disabled" : ""}>‹</button>
              <span class="reader-page">${page} / ${totalPages}</span>
              <button data-next ${page >= pdf.numPages ? "disabled" : ""}>›</button>
            `;
            $("[data-prev]", controls)?.addEventListener("click", async () => {
              if (drawInProgress || page <= firstPage) return;
              page--;
              await drawSinglePage();
            });
            $("[data-next]", controls)?.addEventListener("click", async () => {
              if (drawInProgress || page >= pdf.numPages) return;
              page++;
              await drawSinglePage();
            });
            if (page === pdf.numPages) {
              const nextButton = $("[data-next]", controls);
              nextButton?.removeAttribute("disabled");
              nextButton?.addEventListener("click", async () => {
                if (drawInProgress) return;
                page++;
                await drawSinglePage();
              }, { once: true });
            }
            onPageChange(item, page, totalPages);
          } finally {
            drawInProgress = false;
          }
        }
        await drawSinglePage();
      } else if (currentReadingMode === 'double-page') {
        let spread = Math.max(0, Math.floor((resumePage - 1) / 2));
        const spreadContainer = document.createElement("div");
        spreadContainer.className = "reader-double-page";

        async function drawSpread() {
          const totalPages = pdf.numPages + 1;
          const pagesToRender = getReaderSpreadPages(totalPages, spread, skipCover);
          const page2Number = pagesToRender[pagesToRender.length - 1];

          spreadContainer.innerHTML = "";
          const pages = [];

          for (const pageNumber of pagesToRender) {
            if (pageNumber === totalPages) {
              const wrapper = document.createElement("div");
              wrapper.className = "double-page";
              wrapper.appendChild(readerEndPageImage());
              spreadContainer.appendChild(wrapper);
              pages.push(pageNumber);
              continue;
            }
            const page = await pdf.getPage(pageNumber);
            const baseViewport = page.getViewport({ scale: 1 });
            const availableWidth = Math.max(240, (body.clientWidth - 70) / pagesToRender.length);
            const availableHeight = Math.max(240, body.clientHeight - 40);
            const scale = Math.max(0.5, Math.min(1.5, availableWidth / baseViewport.width, availableHeight / baseViewport.height));
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement("canvas");
            canvas.className = "reader-canvas";
            const dpr = window.devicePixelRatio || 1;
            canvas.width = Math.floor(viewport.width * dpr);
            canvas.height = Math.floor(viewport.height * dpr);
            canvas.style.width = `${viewport.width}px`;
            canvas.style.height = `${viewport.height}px`;
            const ctx = canvas.getContext("2d", { alpha: false });
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            await page.render({ canvasContext: ctx, viewport }).promise;

            const wrapper = document.createElement("div");
            wrapper.className = "double-page";
            wrapper.appendChild(canvas);
            spreadContainer.appendChild(wrapper);
            pages.push(pageNumber);
          }

          const displayedPages = [...pages].sort((a, b) => a - b);
          if (!spreadContainer.isConnected) body.replaceChildren(spreadContainer);

          controls.innerHTML = `
            <button data-prev ${spread === 0 ? "disabled" : ""}>‹</button>
            <span class="reader-page">
              ${displayedPages[0]}${displayedPages[1] ? `–${displayedPages[1]}` : ""} / ${totalPages}
            </span>
            <button data-next ${page2Number >= pdf.numPages ? "disabled" : ""}>›</button>
          `;

          $("[data-prev]", controls)?.addEventListener("click", async () => {
            if (spread > 0) {
              spread--;
              await drawSpread();
            }
          });

          $("[data-next]", controls)?.addEventListener("click", async () => {
            if (page2Number < pdf.numPages) {
              spread++;
              await drawSpread();
            }
          });
          if (page2Number === pdf.numPages) {
            const nextButton = $("[data-next]", controls);
            nextButton?.removeAttribute("disabled");
            nextButton?.addEventListener("click", async () => { spread++; await drawSpread(); }, { once: true });
          }
          onPageChange(item, pagesToRender[0], totalPages);
        }

        await drawSpread();
      } else if (currentReadingMode === 'continuous-scroll') {
        const pageContainer = document.createElement("div");
        pageContainer.className = "pdf-continuous-scroll-container";
        body.replaceChildren(pageContainer);

        const pageElements = [];
        const renderedPages = new Set();
        const observer = new IntersectionObserver(async (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              if (entry.target.dataset.readerEndPage === "true") continue;
              const pageNum = parseInt(entry.target.dataset.pageNum);
              if (!renderedPages.has(pageNum)) {
                renderedPages.add(pageNum);
                const canvas = entry.target.querySelector('canvas');
                try {
                const p = await pdf.getPage(pageNum);
                // Smaller scale for continuous scroll to fit more pages
                const baseViewport = p.getViewport({ scale: 1 });
                const scale = Math.max(0.5, Math.min(1.5, (pageContainer.clientWidth - 40) / baseViewport.width));
                const viewport = p.getViewport({ scale });
                const dpr = window.devicePixelRatio || 1;
                canvas.width = Math.floor(viewport.width * dpr);
                canvas.height = Math.floor(viewport.height * dpr);
                canvas.style.width = `${viewport.width}px`;
                canvas.style.height = `${viewport.height}px`;
                const ctx = canvas.getContext("2d", { alpha: false });
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.fillStyle = "white";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                await p.render({ canvasContext: ctx, viewport }).promise;
                finishReaderPageLoading(entry.target);
                } catch (error) {
                  finishReaderPageLoading(entry.target, error);
                  console.error("[PDF] Falha ao renderizar página", pageNum, error);
                }
              }
            }
          }
        }, { root: pageContainer, rootMargin: '200px' }); // Render pages when they are 200px near the viewport

        for (const i of getReaderPages(pdf.numPages, skipCover)) {
          const pageWrapper = document.createElement("div");
          pageWrapper.className = "pdf-page-wrapper";
          pageWrapper.dataset.pageNum = i;
          const canvas = document.createElement("canvas");
          canvas.className = "reader-canvas";
          pageWrapper.appendChild(canvas);
          showReaderPageLoading(pageWrapper);
          pageContainer.appendChild(pageWrapper);
          pageElements.push(pageWrapper);
          observer.observe(pageWrapper);
        }
        const endPageWrapper = document.createElement("div");
        endPageWrapper.className = "pdf-page-wrapper";
        endPageWrapper.dataset.pageNum = pdf.numPages + 1;
        endPageWrapper.dataset.readerEndPage = "true";
        endPageWrapper.appendChild(readerEndPageImage());
        pageContainer.appendChild(endPageWrapper);
        pageElements.push(endPageWrapper);
        observer.observe(endPageWrapper);

        let currentPageIndex = 0; // 0-indexed
        const updateControls = () => {
          const visiblePage = pageElements.find(el => {
            const rect = el.getBoundingClientRect();
            return rect.top >= 0 && rect.top < window.innerHeight / 2; // Check if top half of page is visible
          }) || pageElements[0]; // Default to first page if none are clearly visible

          currentPageIndex = pageElements.indexOf(visiblePage);
          onPageChange(item, Number(visiblePage.dataset.pageNum), pdf.numPages + 1);

          controls.innerHTML = `
            <button data-prev ${currentPageIndex <= 0 ? "disabled" : ""}>↑</button>
            <span class="reader-page">${pageElements[currentPageIndex].dataset.pageNum} / ${pdf.numPages + 1}</span>
            <button data-next ${currentPageIndex >= pageElements.length - 1 ? "disabled" : ""}>↓</button>
          `;
          $("[data-prev]", controls)?.addEventListener("click", () => {
            if (currentPageIndex > 0) {
              currentPageIndex--;
              pageElements[currentPageIndex].scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          });
          $("[data-next]", controls)?.addEventListener("click", () => {
            if (currentPageIndex < pageElements.length - 1) {
              currentPageIndex++;
              pageElements[currentPageIndex].scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          });
        };

        pageContainer.addEventListener('scroll', updateControls);
        updateControls(); // Call once to set initial state
        pageElements.find(el => Number(el.dataset.pageNum) === resumePage)?.scrollIntoView({ block: 'start' });

        // Clean up observer and event listener when overlay is removed
        if (overlay) {
          $("[data-close-reader]", overlay).addEventListener('click', () => {
            observer.disconnect();
            pageContainer.removeEventListener('scroll', updateControls);
          }, { once: true });
        }
      }

      const modeSelect = $("#reading-mode-select", overlay);
      if (modeSelect) {
        modeSelect.disabled = false;
        modeSelect.addEventListener('change', (e) => {
          setReadingMode(e.target.value);
          overlay._reopenReader?.({ skipCover });
        });
      }
    } catch (err) {
      console.error(err);
      let title = "Não foi possível renderizar este PDF.";
      let message = "Ocorreu um erro inesperado. Verifique o console do navegador para mais detalhes.";

      if (err.name === 'PDFJS_MISSING') {
        title = "PDF.js não carregado.";
        message = "A biblioteca necessária para renderizar o PDF não está disponível nesta página.";
      } else if (err.name === 'MissingPDFException') {
        title = "Arquivo PDF não encontrado.";
        message = `O navegador não conseguiu carregar o arquivo a partir do link fornecido. Verifique se o caminho no cadastro está correto.`;
      } else if (err.name === 'InvalidPDFException') {
        title = "Arquivo PDF inválido.";
        message = "O arquivo parece estar corrompido ou em um formato que não pode ser lido pelo leitor. Tente abrir o arquivo diretamente.";
      } else if (String(err.message).toLowerCase().includes("cors") || String(err.message).toLowerCase().includes("failed to fetch")) {
        title = "Erro de CORS";
        message = "O servidor que hospeda o PDF não permite que este site o acesse diretamente. Use o botão abaixo para abrir em uma nova aba.";
      }

      body.innerHTML = `
        <div class="empty" style="margin:auto;max-width:650px">
          <h3>${escapeHTML(title)}</h3>
          <p>${escapeHTML(message)}</p>
          <button class="btn btn-primary" data-report-file>Relatar arquivo</button>
        </div>`;
      controls.innerHTML = `<span class="reader-page">PDF</span>`;
      $("[data-report-file]", body).onclick = () => reportFileFailure(item, `${title} ${message}`);
    }
  }

  async function renderCBZRangeSinglePage(item, url, body, controls, overlay, skipCover, resumePage, onPageChange) {
    const isMega = /^https:\/\/(?:www\.)?mega\.nz\/file\//i.test(String(url || ""));
    // Telegram-hosted CBZs can also use HTTP range reads. Keep the fast path
    // for single-page mode; other modes fall back to the regular archive reader.
    if (item.local || isMega || state.readingMode !== "single-page" || !window.zipJsReady || !/^https?:\/\//i.test(url)) return false;
    let reader;
    try {
      const zipjs = await window.zipJsReady;
      if (!zipjs?.ZipReader || !zipjs?.HttpReader || !zipjs?.BlobWriter) return false;
      reader = new zipjs.ZipReader(new zipjs.HttpReader(proxiedFileUrl(url)));
      const entries = (await reader.getEntries()).filter(entry => !entry.directory && /\.(jpg|jpeg|png|webp|gif)$/i.test(entry.filename)).sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
      if (!entries.length) throw new Error("CBZ sem imagens.");
      const pages = getReaderPages(entries.length, skipCover).map(page => page - 1);
      const requestedPage = Math.max(1, resumePage || 1);
      let page = pages.includes(requestedPage - 1) ? requestedPage - 1 : pages[0];
      const img = document.createElement("img");
      img.className = "reader-image";
      const urls = new Set();
      const pageBlobs = new Map();
      const pageLoads = new Map();
      const getPageBlob = index => {
        if (pageBlobs.has(index)) return Promise.resolve(pageBlobs.get(index));
        if (!pageLoads.has(index)) {
          pageLoads.set(index, entries[index].getData(new zipjs.BlobWriter()).then(blob => {
            pageBlobs.set(index, blob);
            return blob;
          }).finally(() => pageLoads.delete(index)));
        }
        return pageLoads.get(index);
      };
      const prefetchAround = index => {
        // Warm the next pages in the background so turning pages doesn't
        // trigger a new network wait or re-display the loading status.
        for (const nextIndex of [index + 1, index + 2, index - 1]) {
          if (nextIndex >= pages[0] && nextIndex < entries.length && pages.includes(nextIndex) && !pageBlobs.has(nextIndex)) {
            void getPageBlob(nextIndex).catch(() => {});
          }
        }
      };
      const draw = async () => {
        const blob = await getPageBlob(page);
        prefetchAround(page);
        const objectUrl = URL.createObjectURL(blob);
        urls.add(objectUrl);
        if (img.dataset.url) { URL.revokeObjectURL(img.dataset.url); urls.delete(img.dataset.url); }
        img.dataset.url = objectUrl;
        img.src = objectUrl;
        await img.decode();
        if (!img.isConnected) body.replaceChildren(img);
        controls.innerHTML = `<button data-prev ${page <= pages[0] ? "disabled" : ""}>‹</button><span class="reader-page">${page + 1} / ${entries.length}</span><button data-next ${page >= pages[pages.length - 1] ? "disabled" : ""}>›</button>`;
        $("[data-prev]", controls)?.addEventListener("click", async () => { const position = pages.indexOf(page); if (position > 0) { page = pages[position - 1]; await draw(); } });
        $("[data-next]", controls)?.addEventListener("click", async () => { const position = pages.indexOf(page); if (position < pages.length - 1) { page = pages[position + 1]; await draw(); } });
        onPageChange(item, page + 1, entries.length);
      };
      await draw();
      const modeSelect = $("#reading-mode-select", overlay);
      if (modeSelect) {
        modeSelect.disabled = false;
        modeSelect.value = "single-page";
        modeSelect.addEventListener("change", event => {
          setReadingMode(event.target.value);
          overlay._reopenReader?.({ skipCover });
        });
      }
      $("[data-close-reader]", overlay).addEventListener("click", async () => {
        for (const objectUrl of urls) URL.revokeObjectURL(objectUrl);
        pageBlobs.clear();
        await reader.close();
      }, { once: true });
      return true;
    } catch (error) {
      try { await reader?.close(); } catch {}
      if (!isInvalidZipError(error)) console.warn("CBZ por Range indisponível; usando fallback:", error);
      return false;
    }
  }

  async function zipJsArchiveFromBuffer(buffer) {
    if (!window.zipJsReady) return null;
    const zipjs = await window.zipJsReady;
    if (!zipjs?.ZipReader || !zipjs?.Uint8ArrayReader || !zipjs?.BlobWriter) return null;
    const reader = new zipjs.ZipReader(new zipjs.Uint8ArrayReader(new Uint8Array(buffer)));
    const entries = await reader.getEntries();
    const files = {};
    entries.forEach(entry => {
      files[entry.filename] = {
        dir: Boolean(entry.directory),
        async: () => entry.getData(new zipjs.BlobWriter()),
      };
    });
    return { files, close: () => reader.close() };
  }

  async function renderCBZReader(item, url, body, controls, overlay, skipCover = false, resumePage = 1, onPageChange = () => {}, prefetchedBuffer = null) {
    const downloadController = new AbortController();
    overlay._cbzDownloadController = downloadController;
    let progressRoot;
    let progressLabel;
    let progressBar;
    let progressDetail;
    const showCbzProgress = (message, value = null, detail = "") => {
      if (/de 0(?:\.0+)? MB/.test(detail)) {
        value = null;
        detail = "";
      }
      if (!progressRoot || !progressRoot.isConnected) {
        progressRoot = document.createElement("div");
        progressRoot.className = "reader-loading";
        progressRoot.setAttribute("role", "status");
        progressLabel = document.createElement("div");
        progressLabel.className = "reader-loading-label";
        progressBar = document.createElement("progress");
        progressBar.className = "reader-progress";
        progressBar.max = 100;
        progressDetail = document.createElement("div");
        progressDetail.className = "reader-loading-detail";
        progressRoot.append(progressLabel, progressBar, progressDetail);
        progressRoot.insertAdjacentHTML("beforeend", readerLoadingTipMarkup());
        body.replaceChildren(progressRoot);
      }
      progressLabel.textContent = message;
      if (value === null) {
        progressBar.hidden = false;
        progressBar.removeAttribute("value");
        progressDetail.hidden = !detail;
        progressDetail.textContent = detail;
      } else {
        progressBar.value = value;
        progressDetail.hidden = false;
        progressDetail.textContent = detail;
      }
    };
    showCbzProgress("Abrindo arquivo CBZ…");
    try {
      // Telegram metadata already identifies the format. Try opening only the
      // requested page before probing the signature or waiting for JSZip.
      const telegramRange = isTelegramMediaUrl(url) && state.readingMode === "single-page";
      if (telegramRange && await renderCBZRangeSinglePage(item, url, body, controls, overlay, skipCover, resumePage, onPageChange)) return;
      const archiveSignature = await probeArchiveSignature(url);
      if (isRarSignature(archiveSignature)) {
        console.info("[CBZ] Contêiner RAR detectado; encaminhando para o leitor CBR.");
        await ensureReaderDependency("cbr");
        return renderCBRReader(item, url, body, controls, overlay, skipCover, resumePage, onPageChange, null);
      }
      if (!telegramRange && await renderCBZRangeSinglePage(item, url, body, controls, overlay, skipCover, resumePage, onPageChange)) return;
      let JSZipLib = await (window.jszipReady || Promise.resolve(window.JSZip));
      if (!JSZipLib) JSZipLib = { loadAsync: async archiveBuffer => {
        const archive = await zipJsArchiveFromBuffer(archiveBuffer);
        if (!archive) throw new Error("Nenhum leitor ZIP está disponível.");
        return archive;
      } };
      if (!JSZipLib) throw new Error("JSZip não carregou.");
      let buffer = await waitForPrefetchedBuffer(prefetchedBuffer);
      if (buffer) showCbzProgress("Arquivo CBZ carregado. Preparando p\u00e1ginas...", 100, "Abertura conclu\u00edda");
      if (!buffer) {
        // fetchFileArrayBuffer usa faixas independentes para Mega/servidores
        // que derrubam streams longos, evitando ERR_QUIC_PROTOCOL_ERROR.
        buffer = await fetchFileArrayBuffer(url, (received, total) => {
          const value = total ? Math.min(99, Math.round(received / total * 100)) : null;
          const detail = total
            ? `${(received / 1048576).toFixed(1)} MB de ${(total / 1048576).toFixed(1)} MB`
            : `${(received / 1048576).toFixed(1)} MB processados`;
          showCbzProgress("Abrindo arquivo CBZ…", value, detail);
        }, undefined, downloadController.signal);
      }
      let zip;
      try {
        zip = await JSZipLib.loadAsync(buffer);
      } catch (error) {
        const isZipStructureError = /end of central directory|central directory|is this a zip file/i.test(String(error?.message || error));
        if (!isZipStructureError || /^blob:/i.test(String(url || ""))) throw error;
        const proxyUrl = proxiedFileUrl(url);
        await deleteReaderFileCache(`${proxyUrl}${proxyUrl.includes("?") ? "&" : "?"}v=240`);
        showCbzProgress("Arquivo incompleto. Tentando baixar novamente…");
        buffer = await fetchFileArrayBuffer(url, (received, total) => {
          const value = total ? Math.min(99, Math.round(received / total * 100)) : null;
          const detail = total
            ? `${(received / 1048576).toFixed(1)} MB de ${(total / 1048576).toFixed(1)} MB`
            : `${(received / 1048576).toFixed(1)} MB processados`;
          showCbzProgress("Carregando arquivo CBZ…", value, detail);
        }, undefined, downloadController.signal, true);
        if (!hasZipEndRecord(buffer)) throw error;
        zip = await JSZipLib.loadAsync(buffer);
      }
      const names = Object.keys(zip.files)
        .filter(n => !zip.files[n].dir && /\.(jpg|jpeg|png|webp|gif)$/i.test(n))
        .sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));
      if (!names.length) throw new Error("CBZ sem imagens.");
      showCbzProgress("Preparando páginas…", 0, `0 de ${names.length} páginas`);

      const currentReadingMode = state.readingMode;

      if (currentReadingMode === 'single-page') {
        const firstIndex = skipCover && names.length > 1 ? 1 : 0;
        const totalPages = names.length + 1;
        let page = Math.max(firstIndex, Math.min(resumePage - 1, totalPages - 1));
        const pageCache = createArchivePageCache(names, name => zip.files[name].async("blob"));
        const img = document.createElement("img");
        img.className = "reader-image";

        async function draw() {
          if (page === names.length) {
            if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
            delete img.dataset.url;
            img.src = READER_END_PAGE_URL;
            img.alt = "Página final";
            if (!img.isConnected) body.replaceChildren(img);
            controls.innerHTML = `<button data-prev>‹</button><span class="reader-page">${page + 1} / ${totalPages}</span><button data-next disabled>›</button>`;
            $("[data-prev]", controls)?.addEventListener("click", async () => { page--; await draw(); });
            onPageChange(item, page + 1, totalPages);
            return;
          }
          const currentThird = Math.floor(page / pageCache.thirdSize);
          const blob = await pageCache.get(page);
          // Exibe a página atual primeiro; o restante do terço é pré-carregado
          // em segundo plano para a navegação seguinte.
          void pageCache.prefetchThird(currentThird).catch(() => {});
          void pageCache.prefetchThird(currentThird + 1).catch(() => {});
          if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
          const objectUrl = URL.createObjectURL(blob);
          img.dataset.url = objectUrl;
          img.src = objectUrl;
          await img.decode();
          if (!img.isConnected) body.replaceChildren(img);
          controls.innerHTML = `
            <button data-prev ${page <= firstIndex ? "disabled" : ""}>‹</button>
            <span class="reader-page">${page + 1} / ${names.length}</span>
            <button data-next ${page === names.length - 1 ? "disabled" : ""}>›</button>
          `;
          $("[data-prev]", controls)?.addEventListener("click", async () => { if(page>0){page--;await draw();} });
          $("[data-next]", controls)?.addEventListener("click", async () => { if(page<names.length-1){page++;await draw();} });
          if (page === names.length - 1) {
            const nextButton = $("[data-next]", controls);
            nextButton?.removeAttribute("disabled");
            nextButton?.addEventListener("click", async () => { page++; await draw(); }, { once: true });
          }
          onPageChange(item, page + 1, totalPages);
        }
        await draw();
        $("[data-close-reader]", overlay).addEventListener('click', () => {
          if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
        }, { once: true });
      } else if (currentReadingMode === 'double-page') {

        let spread = Math.max(0, Math.floor((resumePage - 1) / 2));
        const spreadContainer = document.createElement("div");
        spreadContainer.className = "reader-double-page";
        const spreadUrls = [];

        async function drawSpread() {
          // Libera URLs anteriores
          for (const u of spreadUrls) {
            URL.revokeObjectURL(u);
          }
          spreadUrls.length = 0;
          spreadContainer.innerHTML = "";

          const totalPages = names.length + 1;
          const indexesToRender = getReaderSpreadIndexes(totalPages, spread, skipCover);
          const second = indexesToRender[indexesToRender.length - 1];

          for (const index of indexesToRender) {
            if (index === names.length) {
              const wrapper = document.createElement("div");
              wrapper.className = "double-page";
              wrapper.appendChild(readerEndPageImage());
              spreadContainer.appendChild(wrapper);
              continue;
            }
            const blob = await zip.files[names[index]].async("blob");
            const objectUrl = URL.createObjectURL(blob);
            spreadUrls.push(objectUrl);

            const wrapper = document.createElement("div");
            wrapper.className = "double-page";

            const img = document.createElement("img");
            img.className = "reader-image";
            img.src = objectUrl;
            img.alt = `Página ${index + 1}`;
            await img.decode();

            wrapper.appendChild(img);
            spreadContainer.appendChild(wrapper);
          }

          const displayedPages = indexesToRender.map(p => p + 1).sort((a, b) => a - b);
          if (!spreadContainer.isConnected) body.replaceChildren(spreadContainer);

          controls.innerHTML = `
            <button data-prev ${spread === 0 ? "disabled" : ""}>‹</button>
            <span class="reader-page">
              ${displayedPages[0]}${displayedPages[1] ? `–${displayedPages[1]}` : ""} / ${names.length}
            </span>
            <button data-next ${second >= names.length - 1 ? "disabled" : ""}>›</button>
          `;

          $("[data-prev]", controls)?.addEventListener("click", async () => {
            if (spread > 0) { spread--; await drawSpread(); }
          });

          $("[data-next]", controls)?.addEventListener("click", async () => {
            if (second < names.length - 1) { spread++; await drawSpread(); }
          });
          if (second === names.length - 1) {
            const nextButton = $("[data-next]", controls);
            nextButton?.removeAttribute("disabled");
            nextButton?.addEventListener("click", async () => { spread++; await drawSpread(); }, { once: true });
          }
          onPageChange(item, indexesToRender[0] + 1, totalPages);
        }

        await drawSpread();

        $("[data-close-reader]", overlay).addEventListener("click", () => {
          for (const u of spreadUrls) {
            URL.revokeObjectURL(u);
          }
        }, { once: true });
      } else if (currentReadingMode === 'continuous-scroll') {
        const pageContainer = document.createElement("div");
        pageContainer.className = "image-continuous-scroll-container"; // Note: class name was correct
        body.replaceChildren(pageContainer);

        const objectUrls = [];
        const pageElements = [];

        // Extrai páginas somente quando se aproximam da viewport.
        const pageStates = new Map();
        // Pages are extracted on demand below.
        // Legacy eager-extraction block removed.
        /*
          const blob = await zip.files[name].async("blob");
          const url = URL.createObjectURL(blob);
          objectUrls.push(url);
          extractedPages += 1;
          showCbzProgress("Extraindo páginas do CBZ…", Math.round(extractedPages / names.length * 100), `${extractedPages} de ${names.length} páginas`);
          return { src: url };
        */

        body.replaceChildren(pageContainer); // Clear status message

        const loadPage = async pageWrapper => {
          if (pageWrapper.dataset.readerEndPage === "true") return;
          const index = Number(pageWrapper.dataset.pageNum) - 1;
          const state = pageStates.get(index);
          if (!state || state.url || state.loading) return state?.loading;
          state.loading = (async () => {
            const blob = await zip.files[names[index]].async("blob");
            state.url = URL.createObjectURL(blob);
            state.img.src = state.url;
            objectUrls.push(state.url);
            await state.img.decode();
            finishReaderPageLoading(pageWrapper);
          })().catch(error => {
            finishReaderPageLoading(pageWrapper, error);
            console.error("[CBZ] Falha ao extrair página", index + 1, error);
          }).finally(() => { state.loading = null; });
          return state.loading;
        };
        const releasePage = pageWrapper => {
          if (pageWrapper.dataset.readerEndPage === "true") return;
          const state = pageStates.get(Number(pageWrapper.dataset.pageNum) - 1);
          if (!state?.url) return;
          URL.revokeObjectURL(state.url);
          objectUrls.splice(objectUrls.indexOf(state.url), 1);
          state.url = null;
          state.img.removeAttribute("src");
          showReaderPageLoading(pageWrapper);
        };

        getReaderPages(names.length, skipCover).forEach(pageNum => {
          const index = pageNum - 1;
          const pageWrapper = document.createElement("div");
          pageWrapper.className = "image-page-wrapper";
          pageWrapper.dataset.pageNum = pageNum;
          const img = document.createElement("img");
          img.className = "reader-image";
          img.alt = `Página ${pageNum}`;
          pageWrapper.appendChild(img);
          showReaderPageLoading(pageWrapper);
          pageContainer.appendChild(pageWrapper);
          pageElements.push(pageWrapper);
          pageStates.set(index, { img, url: null, loading: null });
        });
        const endPageWrapper = document.createElement("div");
        endPageWrapper.className = "image-page-wrapper";
        endPageWrapper.dataset.pageNum = names.length + 1;
        endPageWrapper.dataset.readerEndPage = "true";
        endPageWrapper.appendChild(readerEndPageImage());
        pageContainer.appendChild(endPageWrapper);
        pageElements.push(endPageWrapper);

        const observer = new IntersectionObserver(entries => {
          entries.forEach(entry => entry.isIntersecting ? loadPage(entry.target) : releasePage(entry.target));
        }, { root: pageContainer, rootMargin: "150% 0px" });
        pageElements.forEach(page => observer.observe(page));

        let currentPageIndex = 0;
        const updateControls = () => {
          const visiblePage = pageElements.find(el => {
            const rect = el.getBoundingClientRect();
            return rect.top >= 0 && rect.top < window.innerHeight / 2;
          }) || pageElements.find(el => {
            const rect = el.getBoundingClientRect();
            // Check if any part of the element is visible in the viewport
            return rect.bottom > 0 && rect.top < window.innerHeight;
          }) || pageElements[0];

          if (!visiblePage) {
            // If no page is visible (e.g., during initial load or very fast scroll), default to the first page
            currentPageIndex = 0;
            return;
          }

          currentPageIndex = pageElements.indexOf(visiblePage);
          controls.innerHTML = `
            <button data-prev ${currentPageIndex <= 0 ? "disabled" : ""}>↑</button>
            <span class="reader-page">${visiblePage.dataset.pageNum} / ${names.length}</span>
            <button data-next ${currentPageIndex >= pageElements.length - 1 ? "disabled" : ""}>↓</button>
          `;
          $("[data-prev]", controls)?.addEventListener("click", () => pageElements[Math.max(0, currentPageIndex - 1)].scrollIntoView({ behavior: 'smooth', block: 'start' }));
          $("[data-next]", controls)?.addEventListener("click", () => pageElements[Math.min(pageElements.length - 1, currentPageIndex + 1)].scrollIntoView({ behavior: 'smooth', block: 'start' }));
          onPageChange(item, Number(visiblePage.dataset.pageNum), names.length);
        };

        pageContainer.addEventListener('scroll', updateControls, { passive: true });
        loadPage(pageElements[0]);
        updateControls();
        pageElements.find(el => Number(el.dataset.pageNum) === resumePage)?.scrollIntoView({ block: 'start' });

        $("[data-close-reader]", overlay).addEventListener('click', () => {
          observer.disconnect();
          pageContainer.removeEventListener('scroll', updateControls);
          for (const url of objectUrls) URL.revokeObjectURL(url);
        }, { once: true });
      }

      const modeSelect = $("#reading-mode-select", overlay);
      if (modeSelect) {
        modeSelect.disabled = false;
        modeSelect.addEventListener('change', (e) => {
          setReadingMode(e.target.value);
          overlay._reopenReader?.({ skipCover });
        });
      }
    } catch (err) {
      if (err?.name === "AbortError" || !overlay.isConnected) return;
      // Local status helper for this function
      const status = (message) => body.innerHTML = `<div class="empty" style="margin:auto">${escapeHTML(message)}</div>`;


      if (isInvalidZipError(err)) {
        console.warn("CBZ inválido ou incompleto: a fonte não entregou um arquivo ZIP completo.");
      } else {
        console.error(err);
      }
      body.innerHTML = `
        <div class="empty" style="margin:auto;max-width:650px">
          <h3>Não temos mais</h3>
          <p>Sentimos muito por não conseguirmos oferecer esta história agora. Se ela deveria continuar disponível, relate o problema aos moderadores do site para tentarmos recuperá-la.</p>
          <button class="btn btn-primary" data-report-file>Relatar arquivo</button>
        </div>`;
      controls.innerHTML = `<span class="reader-page">CBZ</span>`;
      $("[data-report-file]", body).onclick = () => reportFileFailure(item, "O arquivo não abriu no leitor CBZ.");
    }
  }

  async function probeArchiveSignature(url) {
    try {
      const source = String(url || "");
      const response = await fetch(/^blob:/i.test(source) ? source : proxiedFileUrl(source), /^blob:/i.test(source) ? {} : {
        headers: { Range: "bytes=0-7" },
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        priority: "high"
      });
      if (!response.ok && response.status !== 206) return null;
      const reader = response.body?.getReader();
      if (!reader) return new Uint8Array(await response.arrayBuffer()).slice(0, 8);
      const first = await reader.read();
      await reader.cancel().catch(() => {});
      return first.value ? first.value.slice(0, 8) : null;
    } catch (error) {
      console.warn("Não foi possível identificar o contêiner do arquivo:", error);
      return null;
    }
  }

  function isRarSignature(bytes) {
    return bytes?.length >= 7
      && bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21
      && bytes[4] === 0x1a && bytes[5] === 0x07 && (bytes[6] === 0x00 || bytes[6] === 0x01);
  }

  async function renderCBRReader(item, url, body, controls, overlay, skipCover = false, resumePage = 1, onPageChange = () => {}, prefetchedBuffer = null) {
    body.innerHTML = readerLoadingMarkup("Abrindo arquivo CBR…");
    const downloadController = new AbortController();
    overlay._cbrDownloadController = downloadController;
    let objectUrl = null;
    let archive = null;
    let objectUrls = null; // For continuous scroll
    let cbrProgressRoot;
    let cbrProgressLabel;
    let cbrProgressBar;
    let cbrProgressDetail;

    function showCbrProgress(message, value = null, detail = "Aguardando abertura…") {
      const safeValue = Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
      if (!cbrProgressRoot || !cbrProgressRoot.isConnected) {
        cbrProgressRoot = document.createElement("div");
        cbrProgressRoot.className = "reader-loading";
        cbrProgressLabel = document.createElement("div");
        cbrProgressLabel.className = "reader-loading-label";
        cbrProgressBar = document.createElement("progress");
        cbrProgressBar.className = "reader-progress";
        cbrProgressBar.max = 100;
        cbrProgressDetail = document.createElement("div");
        cbrProgressDetail.className = "reader-loading-detail";
        cbrProgressRoot.append(cbrProgressLabel, cbrProgressBar, cbrProgressDetail);
        cbrProgressRoot.insertAdjacentHTML("beforeend", readerLoadingTipMarkup());
        body.replaceChildren(cbrProgressRoot);
      }
      cbrProgressLabel.textContent = message;
      if (value === null) cbrProgressBar.removeAttribute("value");
      else cbrProgressBar.value = safeValue;
      cbrProgressDetail.textContent = detail || `${safeValue.toFixed(0)}%`;
      cbrProgressDetail.hidden = !detail;
    }

    function status(message) {
      showCbrProgress(message, null, "Preparando arquivo…");
    }

    function fail(title, message) {
      console.error("[CBR]", title, message);

      body.innerHTML = `
      <div class="empty" style="margin:auto;max-width:650px">
        <h3>${escapeHTML(title)}</h3>
        <p>${escapeHTML(message)}</p>

        <button class="btn btn-primary" data-report-file>
          Relatar arquivo
        </button>
      </div>
    `;

      controls.innerHTML = `<span class="reader-page">CBR</span>`;

      $("[data-report-file]", body).onclick = () => reportFileFailure(item, "O arquivo não abriu no leitor CBR.");
    }

    function timeoutPromise(ms, message) {
      return new Promise((_, reject) => {
        setTimeout(() => {
          const error = new Error(message);
          error.name = "TimeoutError";
          reject(error);
        }, ms);
      });
    }

    async function withTimeout(promise, ms, message) {
      return Promise.race([
        promise,
        timeoutPromise(ms, message)
      ]);
    }

    try {
      // Alguns arquivos cadastrados como CBR são ZIP/CBZ renomeados.
      // Detecta isso com os primeiros bytes antes de baixar o arquivo completo.
      const signature = await probeArchiveSignature(url);
      if (isZipSignature(signature)) {
        console.info("[CBR] Contêiner ZIP detectado; usando leitor CBZ por Range.");
        await ensureReaderDependency("cbz");
        return renderCBZReader(item, url, body, controls, overlay, skipCover, resumePage, onPageChange, null);
      }
      const libarchivePromise = loadLibarchiveModule();

      // =========================================================
      // 1. BAIXAR CBR
      // =========================================================

      status("Abrindo arquivo CBR…");

      console.log("[CBR] URL:", url);
      const isMegaSource = /^https:\/\/(?:www\.)?mega\.nz\/file\//i.test(String(url || ""));

      // =========================================================
      // 2. LER ARQUIVO
      // =========================================================

      status("Lendo arquivo CBR…");

      const formatCbrBytes = bytes => bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : `${Math.round(bytes / 1024)} KB`;
      let buffer = await waitForPrefetchedBuffer(prefetchedBuffer);
      if (buffer) {
        showCbrProgress("Arquivo CBR carregado. Preparando páginas…", 100, "Abertura concluída");
      } else {
        buffer = await fetchFileArrayBuffer(url, (received, total) => {
          const value = total ? (received / total) * 100 : null;
        showCbrProgress("Abrindo arquivo CBR…", value, total ? `${value.toFixed(0)}% · ${formatCbrBytes(received)} de ${formatCbrBytes(total)}` : `${formatCbrBytes(received)} processados`);
        }, undefined, downloadController.signal);
        console.log(`[CBR] ${isMegaSource ? "Mega" : "Arquivo"} baixado:`, buffer.byteLength, "bytes");
      }

      if (downloadController.signal.aborted) return;
      console.log(
        "[CBR] Tamanho:",
        buffer.byteLength,
        "bytes"
      );

      if (buffer.byteLength < 8) {
        throw new Error("CBR_EMPTY");
      }

      const bytes = new Uint8Array(buffer);

      const preview = new TextDecoder().decode(bytes.slice(0, 128)).trimStart().toLowerCase();
      if (preview.startsWith("<!doctype html") || preview.startsWith("<html") || preview.startsWith("<head")) {
        throw new Error("CBR_HTML_RESPONSE");
      }

      const isRAR5 =
        bytes[0] === 0x52 &&
        bytes[1] === 0x61 &&
        bytes[2] === 0x72 &&
        bytes[3] === 0x21 &&
        bytes[4] === 0x1A &&
        bytes[5] === 0x07 &&
        bytes[6] === 0x01 &&
        bytes[7] === 0x00;

      const isRAR4 =
        bytes[0] === 0x52 &&
        bytes[1] === 0x61 &&
        bytes[2] === 0x72 &&
        bytes[3] === 0x21 &&
        bytes[4] === 0x1A &&
        bytes[5] === 0x07 &&
        bytes[6] === 0x00;

      const rarVersion =
        isRAR5 ? "RAR5" :
        isRAR4 ? "RAR4" :
        "UNKNOWN";
      const isZipContainer = bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;

      console.log(
        "[CBR] Formato detectado:",
        rarVersion
      );

      if (rarVersion === "UNKNOWN" && !isZipContainer) {
        const header = Array.from(bytes.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join(" ");
        console.error("[CBR] Cabeçalho inválido; arquivo baixado não é RAR/ZIP:", header);
        throw new Error("CBR_INVALID_ARCHIVE");
      }

      if (rarVersion === "RAR5") {
        status("RAR5 detectado. Preparando leitor…");
      } else if (rarVersion === "RAR4") {
        status("RAR4 detectado. Preparando leitor…");
      } else {
        if (isZipContainer) {
          status("Arquivo ZIP detectado. Abrindo como CBZ…");
          await ensureReaderDependency("cbz");
          return renderCBZReader(item, url, body, controls, overlay, skipCover, resumePage, onPageChange, buffer);
        }
        status("Formato compactado detectado. Preparando leitor…");
      }

      // =========================================================
      // 3. VERIFICAR LIBARCHIVE
      // =========================================================

      status("Verificando biblioteca CBR…");

      // A importacao ja foi iniciada em paralelo com o download do CBR.

      // =========================================================
      // 4. IMPORTAR LIBARCHIVE
      // =========================================================

      status("Carregando biblioteca CBR…");

      const module = await libarchivePromise;

      console.log(
        "[CBR] módulo carregado:",
        module
      );

      const Archive = module.Archive;

      console.log("[CBR] Archive:", Archive);
      console.log("[CBR] Archive.init:", Archive?.init);
      console.log("[CBR] Archive.open:", Archive?.open);

      if (
        !Archive ||
        typeof Archive.open !== "function" ||
        typeof Archive.init !== "function"
      ) {
        throw new Error(
          "LIBARCHIVE_API_INVALID"
        );
      }

      // =========================================================
      // 5. INICIALIZAR WORKER
      // =========================================================

      status("Inicializando leitor CBR…");

      const workerUrl = appAssetUrl("libarchive/worker-bundle.js");
      Archive.init({
        workerUrl
      });

      console.log(
        "[CBR] Worker configurado:",
        workerUrl
      );

      // =========================================================
      // 6. CRIAR FILE
      // =========================================================

      status("Preparando arquivo RAR…");

      const file = new File(
        [buffer],
        "comic.cbr",
        {
          type: "application/vnd.rar"
        }
      );

      console.log(
        "[CBR] File criado:",
        file.size
      );

      // =========================================================
      // 7. ABRIR RAR
      // =========================================================

      status(
        rarVersion === "RAR5"
          ? "Abrindo RAR5…"
          : "Abrindo RAR…"
      );

      console.log(
        "[CBR] Chamando Archive.open()..."
      );

      archive = await withTimeout(
        Archive.open(file),
        120000,
        "O libarchive demorou mais de 120 segundos para abrir o RAR."
      );

      console.log(
        "[CBR] Arquivo aberto:",
        archive
      );

      // =========================================================
      // 8. LISTAR ARQUIVOS
      // =========================================================

      status("Localizando páginas…");

      const files = await withTimeout(
        archive.getFilesObject(),
        120000,
        "O RAR abriu, mas demorou mais de 120 segundos para listar os arquivos."
      );

      console.log(
        "[CBR] Arquivos encontrados:",
        files
      );

      // =========================================================
      // 9. ENCONTRAR IMAGENS
      // =========================================================


      function findArchiveImages(obj, path = "") {
        const images = [];


        if (!obj || typeof obj !== "object") {
          return images;
        }


        for (const [key, value] of Object.entries(obj)) {


          const currentPath = path
            ? `${path}/${key}`
            : key;


          // Arquivo do libarchive.js
          if (
            value &&
            typeof value === "object" &&
            typeof value.extract === "function"
          ) {


            const fileName =
              value.name ||
              key;


            if (
              /\.(jpg|jpeg|png|webp|gif)$/i.test(
                fileName
              )
            ) {


              images.push({
                name: fileName,
                path: currentPath,
                file: value
              });


            }


            continue;
          }


          // Pasta / diretório
          if (
            value &&
            typeof value === "object"
          ) {


            images.push(
              ...findArchiveImages(
                value,
                currentPath
              )
            );


          }
        }


        return images;
      }


      const imageEntries =
        findArchiveImages(files);


      console.log(
        "[CBR] Imagens encontradas:",
        imageEntries.length
      );


      console.log(
        "[CBR] Lista de imagens:",
        imageEntries.map(
          entry => entry.path
        )
      );


      if (!imageEntries.length) {
        throw new Error(
          "CBR_NO_IMAGES"
        );
      }


      // O restante do leitor trabalha diretamente
      // com os objetos do libarchive.js.
      const imageFiles =
        imageEntries.map(
          entry => entry.file
        );


      console.log(
        "[CBR] Páginas detectadas:",
        imageFiles.map(
          file => file.name
        )
      );

      const currentReadingMode = state.readingMode;

      if (currentReadingMode === 'single-page') {
        const firstIndex = skipCover && imageFiles.length > 1 ? 1 : 0;
        const totalPages = imageFiles.length + 1;
        let page = Math.max(firstIndex, Math.min(resumePage - 1, totalPages - 1));
        const pageCache = createArchivePageCache(imageFiles, file => withTimeout(file.extract(), 120000, "A página demorou mais de 120 segundos para ser extraída."));
        const img = document.createElement("img");
        img.className = "reader-image";
        img.alt = "Página do quadrinho";
        img.decoding = "async";

        async function draw() {
          controls.innerHTML = `<span class="reader-page">Extraindo página ${page + 1}…</span>`;
          if (page === imageFiles.length) {
            if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
            img.src = READER_END_PAGE_URL;
          } else {
          const currentThird = Math.floor(page / pageCache.thirdSize);
          const extracted = await pageCache.get(page);
          // Não bloqueia a primeira página esperando dezenas de extrações.
          void pageCache.prefetchThird(currentThird).catch(() => {});
          void pageCache.prefetchThird(currentThird + 1).catch(() => {});
          const blob = extracted instanceof Blob ? extracted : new Blob([extracted], { type: "image/jpeg" });
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = URL.createObjectURL(blob);
          img.src = objectUrl;
          }
          await img.decode();
          if (!img.isConnected) body.replaceChildren(img);
          controls.innerHTML = `
            <button data-prev ${page <= firstIndex ? "disabled" : ""}>‹</button>
            <span class="reader-page">${page + 1} / ${totalPages}</span>
            <button data-next ${page === imageFiles.length - 1 ? "disabled" : ""}>›</button>
          `;
          $("[data-prev]", controls)?.addEventListener("click", async () => { if (page > 0) { page--; await draw().catch(e => { page++; console.error(e); }); } });
          $("[data-next]", controls)?.addEventListener("click", async () => { if (page < imageFiles.length - 1) { page++; await draw().catch(e => { page--; console.error(e); }); } });
          if (page === imageFiles.length - 1) {
            const nextButton = $("[data-next]", controls);
            nextButton?.removeAttribute("disabled");
            nextButton?.addEventListener("click", async () => { page++; await draw().catch(e => { page--; console.error(e); }); }, { once: true });
          }
          onPageChange(item, page + 1, totalPages);
        }
        await draw();
        $("[data-close-reader]", overlay).addEventListener('click', () => {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          archive?.close?.();
        }, { once: true });
      } else if (currentReadingMode === 'double-page') {
        let spread = Math.max(0, Math.floor((resumePage - 1) / 2));
        const spreadContainer = document.createElement("div");
        spreadContainer.className = "reader-double-page";
        const spreadUrls = [];

        async function drawSpread() {
          // Libera URLs anteriores
          for (const u of spreadUrls) {
            URL.revokeObjectURL(u);
          }
          spreadUrls.length = 0;
          spreadContainer.innerHTML = "";

          const totalPages = imageFiles.length + 1;
          const indexesToRender = getReaderSpreadIndexes(totalPages, spread, skipCover);
          const second = indexesToRender[indexesToRender.length - 1];

          for (const index of indexesToRender) {
            if (index === imageFiles.length) {
              const wrapper = document.createElement("div");
              wrapper.className = "double-page";
              const img = document.createElement("img");
              img.className = "reader-image";
              img.alt = "Página final";
              img.src = READER_END_PAGE_URL;
              wrapper.appendChild(img);
              spreadContainer.appendChild(wrapper);
              continue;
            }
            const extracted = await withTimeout(
              imageFiles[index].extract(),
              120000,
              "A página demorou mais de 120 segundos para ser extraída."
            );

            const blob = extracted instanceof Blob ? extracted : new Blob([extracted], { type: "image/jpeg" });
            const objectUrl = URL.createObjectURL(blob);
            spreadUrls.push(objectUrl);

            const wrapper = document.createElement("div");
            wrapper.className = "double-page";

            const img = document.createElement("img");
            img.className = "reader-image";
            img.alt = `Página ${index + 1}`;
            img.src = objectUrl;
            await img.decode();

            wrapper.appendChild(img);
            spreadContainer.appendChild(wrapper);
          }

          const displayedPages = indexesToRender.map(p => p + 1).sort((a, b) => a - b);
          if (!spreadContainer.isConnected) body.replaceChildren(spreadContainer);

          controls.innerHTML = `
            <button data-prev ${spread === 0 ? "disabled" : ""}>‹</button>
            <span class="reader-page">
              ${displayedPages[0]}${displayedPages[1] ? `–${displayedPages[1]}` : ""} / ${imageFiles.length}
            </span>
            <button data-next ${second >= imageFiles.length - 1 ? "disabled" : ""}>›</button>
          `;

          $("[data-prev]", controls)?.addEventListener("click", async () => {
            if (spread > 0) { spread--; await drawSpread(); }
          });

          $("[data-next]", controls)?.addEventListener("click", async () => {
            if (second < imageFiles.length - 1) { spread++; await drawSpread(); }
          });
          const readerPageLabel = $(".reader-page", controls);
          if (readerPageLabel) readerPageLabel.textContent = readerPageLabel.textContent.replace(/\/\s*\d+$/, `/ ${totalPages}`);
          if (second === imageFiles.length - 1) {
            const nextButton = $("[data-next]", controls);
            nextButton?.removeAttribute("disabled");
            nextButton?.addEventListener("click", async () => { spread++; await drawSpread(); }, { once: true });
          }
          onPageChange(item, indexesToRender[0] + 1, totalPages);
        }

        await drawSpread();

        $("[data-close-reader]", overlay).addEventListener("click", () => {
          for (const u of spreadUrls) {
            URL.revokeObjectURL(u);
          }
          archive?.close?.();
        }, { once: true });
      } else if (currentReadingMode === 'continuous-scroll') {
        const pageContainer = document.createElement("div");
        pageContainer.className = "image-continuous-scroll-container";
        body.replaceChildren(pageContainer);

        objectUrls = [];
        const pageElements = [];
        const pageStates = new Map();

        imageFiles.forEach((file, index) => {
          if (skipCover && index === 0) return;
          const pageNum = index + 1;
          const pageWrapper = document.createElement("div");
          pageWrapper.className = "image-page-wrapper";
          pageWrapper.style.minHeight = "65vh";
          pageWrapper.style.width = "min(90%, 900px)";
          pageWrapper.dataset.pageNum = pageNum;
          const img = document.createElement("img");
          img.className = "reader-image";
          img.alt = `Página ${pageNum}`;
          pageWrapper.appendChild(img);
          showReaderPageLoading(pageWrapper);
          pageContainer.appendChild(pageWrapper);
          pageElements.push({ file, pageNum, wrapper: pageWrapper, img });
          pageStates.set(index, { url: null, loading: null });
        });

        const endPage = { file: null, pageNum: imageFiles.length + 1, isEnd: true };
        const endWrapper = document.createElement("div");
        endWrapper.className = "image-page-wrapper";
        endWrapper.style.minHeight = "65vh";
        endWrapper.style.width = "min(90%, 900px)";
        endWrapper.dataset.pageNum = endPage.pageNum;
        endPage.wrapper = endWrapper;
        endPage.img = document.createElement("img");
        endPage.img.className = "reader-image";
        endPage.img.alt = "Página final";
        endWrapper.appendChild(endPage.img);
        pageContainer.appendChild(endWrapper);
        pageElements.push(endPage);

        const loadPage = async page => {
          if (page.isEnd) {
            page.img.src = READER_END_PAGE_URL;
            return;
          }
          const pageState = pageStates.get(imageFiles.indexOf(page.file));
          if (!pageState || pageState.url || pageState.loading) return;
          pageState.loading = (async () => {
            const extracted = await withTimeout(page.file.extract(), 120000, "A extração de uma página demorou demais.");
            const blob = extracted instanceof Blob ? extracted : new Blob([extracted], { type: "image/jpeg" });
            pageState.url = URL.createObjectURL(blob);
            page.img.src = pageState.url;
            objectUrls.push(pageState.url);
            await page.img.decode();
            finishReaderPageLoading(page.wrapper);
          })().catch(error => {
            finishReaderPageLoading(page.wrapper, error);
            console.error("[CBR] Falha ao extrair página", page.pageNum, error);
          }).finally(() => {
            pageState.loading = null;
          });
          await pageState.loading;
        };

        const releasePage = page => {
          const pageState = pageStates.get(imageFiles.indexOf(page.file));
          if (!pageState?.url) return;
          URL.revokeObjectURL(pageState.url);
          objectUrls = objectUrls.filter(url => url !== pageState.url);
          pageState.url = null;
          page.img.removeAttribute("src");
          showReaderPageLoading(page.wrapper);
        };

        const observer = new IntersectionObserver(entries => {
          entries.forEach(entry => {
            const page = pageElements.find(candidate => candidate.wrapper === entry.target);
            if (!page) return;
            if (entry.isIntersecting) loadPage(page);
            else releasePage(page);
          });
        }, { root: pageContainer, rootMargin: "150% 0px" });
        pageElements.forEach(page => observer.observe(page.wrapper));

        let currentPageIndex = 0;
        const updateControls = () => {
          const visiblePage = pageElements.find(page => {
            const rect = page.wrapper.getBoundingClientRect();
            return rect.top >= 0 && rect.top < window.innerHeight / 2;
          }) || pageElements.find(page => {
            const rect = page.wrapper.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < window.innerHeight;
          }) || pageElements[0];

          if (!visiblePage) {
            currentPageIndex = 0;
            return;
          }

          currentPageIndex = pageElements.indexOf(visiblePage);
          controls.innerHTML = `
            <button data-prev ${currentPageIndex <= 0 ? "disabled" : ""}>↑</button>
            <span class="reader-page">${visiblePage.pageNum} / ${imageFiles.length + 1}</span>
            <button data-next ${currentPageIndex >= pageElements.length - 1 ? "disabled" : ""}>↓</button>
          `;
          const prevBtn = $("[data-prev]", controls);
          const nextBtn = $("[data-next]", controls);
          prevBtn?.addEventListener("click", () => pageElements[Math.max(0, currentPageIndex - 1)].wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' }));
          nextBtn?.addEventListener("click", () => pageElements[Math.min(pageElements.length - 1, currentPageIndex + 1)].wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' }));
          onPageChange(item, visiblePage.pageNum, imageFiles.length + 1);
        };

        pageContainer.addEventListener('scroll', updateControls, { passive: true });
        loadPage(pageElements[0]);
        updateControls();
        pageElements.find(page => page.pageNum === resumePage)?.wrapper.scrollIntoView({ block: 'start' });

        $("[data-close-reader]", overlay).addEventListener('click', () => {
          observer.disconnect();
          pageContainer.removeEventListener('scroll', updateControls);
          for (const url of objectUrls) URL.revokeObjectURL(url);
          objectUrls = null;
          archive?.close?.();
        }, { once: true });
      }

      const modeSelect = $("#reading-mode-select", overlay);
      if (modeSelect) {
        modeSelect.disabled = false;
        modeSelect.addEventListener('change', (e) => {
          setReadingMode(e.target.value);
          overlay._reopenReader?.({ skipCover });
        });
      }

      console.log(
        "[CBR] ================================="
      );

      console.log(
        "[CBR] LEITOR PRONTO"
      );

      console.log(
        "[CBR] Páginas:",
        imageFiles.length
      );

      console.log(
        "[CBR] ================================="
      );

    } catch (err) {
      archive?.close?.();
      if (objectUrls) {
        for (const url of objectUrls) URL.revokeObjectURL(url);
      }

      if (downloadController.signal.aborted) return;
      console.error(
        "[CBR] ERRO NO LEITOR:",
        err
      );

      const errorText =
        String(
          err?.message || err
        );

      if (
        errorText.includes(
          "LIBARCHIVE_WASM_MISSING"
        )
      ) {

        fail(
          "Biblioteca CBR incompleta.",
          "O arquivo libarchive.wasm não foi encontrado em /libarchive/. Coloque o WASM junto de libarchive.js e worker-bundle.js."
        );

      } else if (
        errorText.includes("LIBARCHIVE_WORKER_MISSING")
      ) {

        fail(
          "Worker do CBR não encontrado.",
          "O arquivo worker-bundle.js não foi encontrado em /libarchive/."
        );

      } else if (
        errorText.includes("LIBARCHIVE_MAIN_MISSING")
      ) {

        fail(
          "Biblioteca CBR não encontrada.",
          "O arquivo libarchive.js não foi encontrado em /libarchive/."
        );

      } else if (
        errorText.includes(
          "LIBARCHIVE_API_INVALID"
        )
      ) {

        fail(
          "Biblioteca CBR incompatível.",
          "O libarchive.js foi carregado, mas sua API Archive não está disponível."
        );

      } else if (
        errorText.includes(
          "CBR_NO_IMAGES"
        )
      ) {

        fail(
          "Nenhuma página encontrada.",
          "O RAR foi aberto, mas nenhuma imagem JPG, PNG, WEBP ou GIF foi encontrada."
        );

      } else if (
        errorText.includes(
          "CBR_EMPTY"
        )
      ) {

        fail(
          "CBR vazio ou inválido.",
          "O arquivo recebido não contém dados suficientes."
        );

      } else if (errorText.includes("CBR_HTML_RESPONSE")) {

        fail(
          "O MediaFire não entregou o CBR.",
          "O servidor devolveu uma página HTML em vez do arquivo. Confirme o link permanente do MediaFire e se a Edge Function mediafire-proxy foi publicada."
        );

      } else if (errorText.includes("CBR_INVALID_SIGNATURE")) {

        fail(
          "Arquivo CBR inválido.",
          "O download terminou, mas o conteúdo não possui assinatura RAR. Verifique o link e o Content-Type exibidos no console."
        );

      } else if (
        errorText.includes(
          "Failed to fetch"
        )
      ) {

        fail(
          "Não foi possível acessar o arquivo.",
          "O servidor pode estar bloqueando o download por CORS."
        );

      } else if (
        errorText.includes(
          "TimeoutError"
        )
      ) {

        fail(
          "O leitor demorou demais.",
          errorText
        );

      } else if (
        /^HTTP \d+/.test(errorText)
      ) {

        fail(
          "Erro ao baixar o CBR.",
          errorText
        );

      } else {

        fail(
          "Não foi possível abrir o CBR.",
          errorText
        );
      }

    }
  }

  return { renderPDFReader, renderCBZReader, renderCBRReader };
}
