const READER_BUILD_ID = "admin-real-page-download-20261028-r14";
console.info("[ComicReader] build", READER_BUILD_ID);
const BANCADIGITAL_BASE = "https://uriel29m.github.io/bancadigital/";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const params = new URLSearchParams(location.search);
let sb = null;
const READER_END_PAGE_URL = BANCADIGITAL_BASE + "assets/somosumabiblioteca.jpg";
let state = {
  readingMode: localStorage.getItem("readingMode") || "single-page",
  readingDirection: localStorage.getItem("readingDirection") || "western",
  recentlyOpenedIds: [],
  readerItemId: null,
  session: null,
  profile: null,
  comicLikeIds: new Set(),
  comicLikeCounts: new Map()
};
let activeReaderCleanup = null;
let readerIsOpen = false;
let handlingRoute = false;
const readerFilePrefetches = new Map();
let activeEditionForPageUrls = null;
let activePageUrls = [];

function escapeHTML(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}
function extension(url) {
  const raw = String(url || "");
  const clean = /^(https?:|blob:|data:)/i.test(raw) ? raw.split("?")[0].split("#")[0] : raw;
  const filename = clean.split(/[\\/]/).pop();
  return /^.+\.[a-z0-9]{1,8}$/i.test(filename) ? filename.split(".").pop().toLowerCase() : "";
}
function readerLoadingTipMarkup() { return ""; }
function readerLoadingMarkup(message) {
  return '<div class="reader-loading" role="status"><div class="reader-loading-label">' +
    escapeHTML(message) +
    '</div><progress class="reader-progress" aria-label="Carregamento da edição"></progress></div>';
}
function showReaderPageLoading(wrapper) {
  if (!wrapper.querySelector(".reader-loading")) wrapper.insertAdjacentHTML("beforeend", readerLoadingMarkup("Carregando página…"));
  wrapper.classList.add("reader-page-loading");
}
function finishReaderPageLoading(wrapper, error = null) {
  const loading = wrapper.querySelector(".reader-loading");
  if (error && loading) loading.textContent = "Não foi possível carregar esta página.";
  else loading?.remove();
  wrapper.classList.remove("reader-page-loading");
}
function isZipSignature(bytes) {
  return bytes?.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}
function hasZipEndRecord(buffer) {
  const bytes = new Uint8Array(buffer || 0);
  const start = Math.max(0, bytes.length - 65557);
  for (let index = bytes.length - 22; index >= start; index -= 1) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) return true;
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x06 && bytes[index + 3] === 0x06) return true;
  }
  return false;
}
function isInvalidZipError(error) {
  return /end of central directory|central directory|is this a zip file/i.test(String(error?.message || error));
}
function getReaderPages(totalPages, skipCover) {
  const firstPage = skipCover && totalPages > 1 ? 2 : 1;
  return Array.from({length: totalPages - firstPage + 1}, (_, index) => firstPage + index);
}
function getReaderSpreadPages(totalPages, spread, skipCover) {
  const pages = getReaderPages(totalPages, skipCover).slice(spread * 2, spread * 2 + 2);
  return state.readingDirection === "eastern" ? pages.reverse() : pages;
}
function getReaderSpreadIndexes(totalPages, spread, skipCover) {
  return getReaderSpreadPages(totalPages, spread, skipCover).map(page => page - 1);
}
function readerEndPageImage() {
  const image = document.createElement("img");
  image.className = "reader-image";
  image.alt = "Página final";
  image.src = READER_END_PAGE_URL;
  return image;
}
function isTelegramMediaUrl(url) {
  try {
    const u = new URL(url);
    return Boolean(window.BANCA_SUPABASE_URL) &&
      u.hostname === new URL(window.BANCA_SUPABASE_URL).hostname &&
      /\/functions\/v1\/telegram-(?:proxy|mtproto)$/.test(u.pathname);
  } catch { return false; }
}
function waitForPrefetchedBuffer(value, timeoutMs = 15000) {
  if (!value) return Promise.resolve(null);
  return Promise.race([
    Promise.resolve(value),
    new Promise(resolve => window.setTimeout(() => resolve(null), timeoutMs))
  ]).catch(() => null);
}
function createArchivePageCache(files, extract) {
  const cache = new Map(), pending = new Map();
  const thirdSize = Math.max(1, Math.ceil(files.length / 3));
  const get = index => {
    if (cache.has(index)) return Promise.resolve(cache.get(index));
    if (!pending.has(index)) {
      pending.set(index, Promise.resolve(extract(files[index])).then(value => {
        cache.set(index, value); pending.delete(index); return value;
      }).catch(error => { pending.delete(index); throw error; }));
    }
    return pending.get(index);
  };
  const prefetchThird = third => {
    if (third < 0 || third > 2) return Promise.resolve();
    const start = third * thirdSize, end = Math.min(files.length, start + thirdSize);
    return Promise.all(Array.from({length: end - start}, (_, offset) => get(start + offset))).then(() => undefined);
  };
  return {get, prefetchThird, thirdSize};
}
function directGoogleDriveUrl(url) {
  const source = String(url || "");
  let parsed;
  try { parsed = new URL(source); } catch { return source; }
  if (!/^(?:drive|docs)\.google\.com$/i.test(parsed.hostname)) return source;
  const pathId = parsed.pathname.match(/\/(?:file\/d|document\/d|spreadsheets\/d|presentation\/d)\/([^/]+)/i)?.[1];
  const id = parsed.searchParams.get("id") || pathId;
  if (!id) return source;
  const direct = new URL("https://drive.usercontent.google.com/download");
  direct.searchParams.set("id", id);
  direct.searchParams.set("export", "download");
  const resourceKey = parsed.searchParams.get("resourcekey");
  if (resourceKey) direct.searchParams.set("resourcekey", resourceKey);
  return direct.toString();
}
function proxiedFileUrl(url) {
  const source = directGoogleDriveUrl(url);
  let parsed;
  try { parsed = new URL(source); } catch { return source; }
  const host = parsed.hostname.toLowerCase();
  const isMediaFire = parsed.protocol === "https:" && (
    host === "mediafire.com" || host === "www.mediafire.com" || /^download\d+\.mediafire\.com$/.test(host)
  );
  const isMega = parsed.protocol === "https:" && (host === "mega.nz" || host === "www.mega.nz") && parsed.pathname.startsWith("/file/");
  const isGoogleDrive = parsed.protocol === "https:" && host === "drive.usercontent.google.com";
  if ((!isMediaFire && !isMega && !isGoogleDrive) || !window.BANCA_SUPABASE_URL) return source;
  const proxyName = isGoogleDrive ? "drive-proxy" : isMega ? "mega-proxy" : "mediafire-proxy";
  const proxy = new URL(String(window.BANCA_SUPABASE_URL).replace(/\/+$/, "") + "/functions/v1/" + proxyName);
  proxy.searchParams.set("url", source);
  return proxy.toString();
}
async function fetchFileArrayBuffer(url, onProgress = () => {}, onComplete = () => {}, signal = null, forceFresh = false) {
  const source = String(url || "");
  const response = await fetch(/^blob:/i.test(source) ? source : proxiedFileUrl(source), {
    method: "GET", mode: "cors", credentials: "omit",
    cache: forceFresh ? "reload" : "no-store",
    ...(signal ? {signal} : {})
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    onProgress(buffer.byteLength, total || buffer.byteLength);
    onComplete();
    return buffer;
  }
  const reader = response.body.getReader(), chunks = [];
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
  chunks.forEach(chunk => {bytes.set(chunk, offset); offset += chunk.byteLength;});
  onComplete();
  return bytes.buffer;
}
async function deleteReaderFileCache() {}
async function ensureReaderDependency(format) {
  const deps = window.BancaReaderDeps;
  if (!deps?.ensure) throw new Error("O carregador original do leitor não foi encontrado.");
  await deps.ensure(format);
}
let readerFormatRenderersPromise = null;
function appAssetUrl(path) { return new URL(String(path).replace(/^\/+/, ""), BANCADIGITAL_BASE).href; }
function loadLibarchiveModule() {
  if (!window.__bancaReaderLibarchive) {
    window.__bancaReaderLibarchive = Promise.all([
      import(appAssetUrl("libarchive/libarchive.js")),
      import(appAssetUrl("libarchive/rar-reader.mjs"))
    ]).then(([module, rar]) => ({...module, Archive: rar.withSolidRarSupport(module.Archive)}));
  }
  return window.__bancaReaderLibarchive;
}
function loadReaderFormatRenderers() {
  if (!readerFormatRenderersPromise) {
    readerFormatRenderersPromise = import("./reader-formats.js?v=original-banca-renderers-20261023")
      .then(module => module.createReaderFormats({
        $, READER_END_PAGE_URL, appAssetUrl, createArchivePageCache,
        deleteReaderFileCache, ensureReaderDependency, escapeHTML,
        fetchFileArrayBuffer, finishReaderPageLoading, getReaderPages,
        getReaderSpreadIndexes, getReaderSpreadPages, hasZipEndRecord,
        isInvalidZipError, isTelegramMediaUrl, isZipSignature,
        loadLibarchiveModule, proxiedFileUrl, readerEndPageImage,
        readerLoadingMarkup, readerLoadingTipMarkup, reportFileFailure,
        setReadingMode, showReaderPageLoading, state, waitForPrefetchedBuffer
      })).catch(error => {readerFormatRenderersPromise = null; throw error;});
  }
  return readerFormatRenderersPromise;
}
async function renderPDFReader(...args) { return (await loadReaderFormatRenderers()).renderPDFReader(...args); }
async function renderCBZReader(...args) { return (await loadReaderFormatRenderers()).renderCBZReader(...args); }
async function renderCBRReader(...args) { return (await loadReaderFormatRenderers()).renderCBRReader(...args); }

function canViewCatalogItem() { return true; }
function isTelegramPostUrl(url) { return /^https?:\/\/(?:www\.)?t(?:elegram)?\.me\//i.test(String(url || "")); }
function isExternalArchiveLink(url) {
  return /^(?:https?:\/\/)(?:(?:www\.)?mediafire\.com\/\?|mega\.co\.nz\/#!)/i.test(String(url || ""));
}
function telegramProxyUrl(item) {
  if (!item?.id || !isTelegramPostUrl(item?.telegramUrl) || !window.BANCA_SUPABASE_URL) return "";
  const proxy = new URL(String(window.BANCA_SUPABASE_URL).replace(/\/+$/, "") + "/functions/v1/telegram-proxy");
  proxy.searchParams.set("item_id", String(item.id));
  return proxy.toString();
}
function downloadSource(item) {
  if (item?.local) return item.fileUrl || "";
  return telegramProxyUrl(item) || item?.fileUrl || (!isTelegramPostUrl(item?.telegramUrl) ? item?.telegramUrl : "") || "";
}
function readerSourceCandidates(item) {
  const primary = downloadSource(item);
  const backups = Array.isArray(item?.backupUrls) ? item.backupUrls : (item?.backupUrl ? [item.backupUrl] : []);
  return [primary, item?.fileUrl, ...backups].map(value => String(value || "").trim()).filter((value, index, values) => value && values.indexOf(value) === index);
}
async function probeReaderSource(url) { return Boolean(url); }
function activateOfflineMode() {}
function downloaded() { return null; }
function openDownloaded() {}
function setSection() {}
function navigate() { location.href = BANCADIGITAL_BASE; }
function currentRouteHistoryIndex() { return Math.max(0, history.length - 1); }
function prioritizeReaderLoading() {}
function recordComicRead() {}
function itemDisplayTitle(item) {
  const title = String(item?.title || item?.name || "Quadrinho").trim();
  const issueSource = item?.issue != null && String(item.issue).trim()
    ? item
    : {...item, issue: item?.issueNumber ?? item?.editionNumber ?? item?.number ?? ""};
  const issue = String(seriesIssueDisplay(issueSource) || "").trim();
  if (!issue) return title;
  const numericIssue = /^\d+(?:\.\d+)?$/.test(issue);
  const label = numericIssue ? "#" + issue : issue;
  const alreadyInTitle = numericIssue
    ? new RegExp("(?:^|[^0-9])#?\\s*" + issue.replace(".", "[.]") + "(?:$|[^0-9])", "i").test(title)
    : title.toLocaleLowerCase().includes(issue.toLocaleLowerCase());
  return alreadyInTitle ? title : title + " " + label;
}
function shouldSkipCover() { return localStorage.getItem("readerSkipCover") === "true"; }
function progressFor(item) {
  try { return JSON.parse(localStorage.getItem("reader-progress:" + String(item?.id || "")) || "null"); } catch { return null; }
}
function saveReadingProgress(item, page, total, completedOverride) {
  try {
    const normalizedPage = Math.max(1, Number(page) || 1);
    const normalizedTotal = Math.max(1, Number(total) || 1);
    const completed = typeof completedOverride === "boolean"
      ? completedOverride
      : normalizedPage >= normalizedTotal;
    localStorage.setItem("reader-progress:" + String(item?.id || ""), JSON.stringify({
      page: normalizedPage, total_pages: normalizedTotal, completed
    }));
  } catch {}
}

async function loadReaderReadStatus(item, button) {
  if (!button || !item?.id || item.local) return null;
  const client = await ensureSupabaseClient();
  const userId = String(state.session?.user?.id || "");
  if (!userId) {
    button.textContent = "Marcar como lida";
    return null;
  }
  const {data, error} = await client.from("reading_progress")
    .select("page,total_pages,completed,completion_source,updated_at")
    .eq("user_id", userId)
    .eq("item_id", String(item.id))
    .maybeSingle();
  if (error) throw error;
  if (state.session?.user?.id !== userId) return null;
  if (data) {
    saveReadingProgress(item, data.page, data.total_pages, Boolean(data.completed));
    button.textContent = data.completed ? "Desmarcar como lida" : "Marcar como lida";
  } else {
    button.textContent = "Marcar como lida";
  }
  return data;
}

async function toggleReadingCompleted(item, totalPages = progressFor(item)?.total_pages || 1) {
  if (!item?.id || item.local) throw new Error("Esta edição não pode ser marcada como lida.");
  const client = await ensureSupabaseClient();
  const userId = String(state.session?.user?.id || "");
  if (!userId) {
    readerAskLogin();
    return null;
  }
  const itemId = String(item.id);
  const {data: current, error: readError} = await client.from("reading_progress")
    .select("page,total_pages,completed")
    .eq("user_id", userId)
    .eq("item_id", itemId)
    .maybeSingle();
  if (readError) throw readError;
  if (state.session?.user?.id !== userId) throw new Error("Sua sessão mudou. Entre novamente e tente outra vez.");

  const local = progressFor(item);
  const total = Math.max(1, Number(current?.total_pages) || Number(totalPages) || Number(local?.total_pages) || 1);
  const page = Math.max(1, Math.min(total, Number(current?.page) || Number(local?.page) || 1));
  // The persisted reading_progress row is authoritative. Local page position is
  // used only for page/total fallback, not to override the completion status.
  const completed = !Boolean(current?.completed);
  const row = {
    user_id: userId,
    item_id: itemId,
    page,
    total_pages: total,
    completed,
    completion_source: completed ? "manual" : null,
    updated_at: new Date().toISOString()
  };
  const {error: writeError} = await client.from("reading_progress")
    .upsert(row, {onConflict: "user_id,item_id"});
  if (writeError) throw writeError;
  saveReadingProgress(item, page, total, completed);
  return completed;
}
function saveSkipCoverPreference(value) {
  try {localStorage.setItem("readerSkipCover", value ? "true" : "false");} catch {}
}
function characterNames(item) { return Array.isArray(item?.characters) ? item.characters : []; }
function readerCustomLinksMarkup() { return ""; }
function isAdminProfile() { return false; }
function toast(message) {
  console.warn("[ComicReader]", message);
  const body = document.querySelector(".reader-body");
  if (body) {
    const note = document.createElement("div");
    note.className = "empty"; note.style.cssText = "margin:auto;max-width:650px;text-align:center;padding:24px";
    note.textContent = String(message);
    body.replaceChildren(note);
  }
}
function readerActionToast(message) {
  let node = document.querySelector("[data-reader-action-toast]");
  if (!node) {
    node = document.createElement("div");
    node.dataset.readerActionToast = "1";
    node.style.cssText = "position:fixed;z-index:100000;left:50%;bottom:24px;transform:translateX(-50%);max-width:90vw;padding:11px 16px;border:1px solid #444;border-radius:10px;background:#171719;color:#fff;font:14px system-ui;text-align:center";
    document.body.appendChild(node);
  }
  node.textContent = String(message || "");
  clearTimeout(node._timer);
  node._timer = setTimeout(() => node.remove(), 3500);
}
function readerLoginUrl() {
  const url = new URL(BANCADIGITAL_BASE);
  url.searchParams.set("pagina", "login");
  return url.href;
}
function readerAskLogin() {
  readerActionToast("Entre na sua conta da Banca Digital para continuar.");
  window.open(readerLoginUrl(), "_blank", "noopener,noreferrer");
}
function updateComicLikeButtons(itemId) {
  const id = String(itemId);
  const liked = state.comicLikeIds.has(id);
  const count = Number(state.comicLikeCounts.get(id) || 0);
  $$("[data-like-item]").filter(button => String(button.dataset.likeItem) === id).forEach(button => {
    button.classList.toggle("is-liked", liked);
    button.textContent = (liked ? "♥" : "♡") + " " + count;
    button.setAttribute("aria-pressed", String(liked));
  });
}
async function toggleComicLike(itemId) {
  const id = String(itemId || state.readerItemId || "");
  if (!id) return;
  try {
    const client = await ensureSupabaseClient();
    const userId = state.session?.user?.id;
    if (!userId) return readerAskLogin();
    const {data: existing, error: selectError} = await client.from("comic_likes")
      .select("item_id").eq("user_id", userId).eq("item_id", id).maybeSingle();
    if (selectError) throw selectError;
    if (existing) {
      const {error} = await client.from("comic_likes").delete().eq("user_id", userId).eq("item_id", id);
      if (error) throw error;
      state.comicLikeIds.delete(id);
    } else {
      const {error} = await client.from("comic_likes").insert({user_id: userId, item_id: id});
      if (error) throw error;
      state.comicLikeIds.add(id);
    }
    const {count, error: countError} = await client.from("comic_likes")
      .select("user_id", {count:"exact",head:true}).eq("item_id", id);
    if (countError) throw countError;
    state.comicLikeCounts.set(id, Number(count) || 0);
    updateComicLikeButtons(id);
  } catch (error) {
    console.error("[ComicReader] Não foi possível atualizar a curtida:", error);
    readerActionToast("Não foi possível atualizar a curtida.");
  }
}
function readerCanonicalShareUrl(itemId) {
  const url = new URL(BANCADIGITAL_BASE);
  if (itemId) url.searchParams.set("ler", String(itemId));
  return url.href;
}
async function shareComic(itemId) {
  const item = (window.DEFAULT_LIBRARY || []).find(entry => String(entry.id) === String(itemId))
    || {id:itemId,title:$("#editionTitle")?.textContent || "Quadrinho"};
  const link = readerCanonicalShareUrl(item.id);
  try {
    if (navigator.share) {
      await navigator.share({title:item.title || "Quadrinho",text:"Leia " + (item.title || "este quadrinho") + " na Banca Digital",url:link});
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(link);
      readerActionToast("Link do quadrinho copiado.");
    } else {
      window.prompt("Copie o link do quadrinho:",link);
    }
  } catch (error) {
    if (error?.name !== "AbortError") { try { window.prompt("Copie o link do quadrinho:",link); } catch {} }
  }
}
function readerProfileHref(username) {
  const url = new URL(BANCADIGITAL_BASE);
  url.searchParams.set("perfil",String(username || ""));
  return url.href;
}
function readerCommentDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short"}).format(date);
}
async function loadReaderCommentThread(item) {
  const client = await ensureSupabaseClient();
  if (state.session?.offline || navigator.onLine === false) return {comments:[],likedIds:new Set(),counts:new Map()};
  let result = await client.from("comments").select("id,parent_id,user_id,body,created_at")
    .eq("item_id",String(item.id)).order("created_at",{ascending:false}).limit(200);
  if (result.error && /parent_id|schema cache|column/i.test(result.error.message || "")) {
    const legacy = await client.from("comments").select("id,user_id,body,created_at")
      .eq("item_id",String(item.id)).order("created_at",{ascending:false}).limit(200);
    result = {...legacy,data:(legacy.data || []).map(comment=>({...comment,parent_id:null}))};
  }
  if (result.error) return {error:result.error,comments:[],likedIds:new Set(),counts:new Map()};
  const comments = result.data || [];
  const userIds = [...new Set(comments.map(comment=>comment.user_id).filter(Boolean))];
  let profiles = [];
  if (userIds.length) {
    const profileResult = await client.from("profiles_public").select("id,username,avatar_url,title,plan").in("id",userIds);
    if (!profileResult.error) profiles = profileResult.data || [];
  }
  const profileMap = new Map(profiles.map(profile=>[String(profile.id),profile]));
  comments.forEach(comment=>{comment.profiles=profileMap.get(String(comment.user_id)) || {};});
  const likesResult = comments.length ? await client.from("comment_likes").select("comment_id,user_id").in("comment_id",comments.map(comment=>comment.id)) : {data:[]};
  const likes = likesResult.error ? [] : (likesResult.data || []);
  const likedIds = new Set(likes.filter(row=>String(row.user_id)===String(state.session?.user?.id || "")).map(row=>Number(row.comment_id)));
  const counts = likes.reduce((map,row)=>map.set(Number(row.comment_id),(map.get(Number(row.comment_id)) || 0)+1),new Map());
  return {comments,likedIds,counts};
}
function readerCommentMarkup(comment, childrenByParent, likedIds, likeCounts) {
  const profile = comment.profiles || {};
  const username = String(profile.username || "usuário");
  const avatar = String(profile.avatar_url || (BANCADIGITAL_BASE + "assets/semfoto.jpg"));
  const id = Number(comment.id);
  const children = childrenByParent.get(id) || [];
  const replies = children.map(child=>readerCommentMarkup(child,childrenByParent,likedIds,likeCounts)).join("");
  const canDelete = String(state.session?.user?.id || "") === String(comment.user_id || "")
    || ["moderator","banca","admin"].includes(state.profile?.plan);
  return '<article class="comment" data-comment-id="' + id + '">' +
    '<div class="comment-author-row"><img class="comment-avatar" src="' + escapeHTML(avatar) + '" alt="Foto de ' + escapeHTML(username) + '" loading="lazy" onerror="this.onerror=null;this.src=\'' + BANCADIGITAL_BASE + 'assets/semfoto.jpg\'">' +
    '<div class="comment-author-info"><a class="comment-author" href="' + escapeHTML(readerProfileHref(username)) + '" target="_blank" rel="noopener noreferrer">@' + escapeHTML(username) + '</a>' +
    (profile.title ? '<span class="comment-title">' + escapeHTML(profile.title) + '</span>' : '') + '</div></div>' +
    '<p>' + escapeHTML(comment.body || "") + '</p><div class="comment-actions">' +
    '<button type="button" class="comment-action ' + (likedIds.has(id) ? "is-liked" : "") + '" data-comment-like="' + id + '">♥ ' + (likeCounts.get(id) || 0) + '</button>' +
    '<button type="button" class="comment-action" data-comment-reply="' + id + '">Responder</button>' +
    (children.length ? '<button type="button" class="comment-action" data-comment-toggle="' + id + '">Ver ' + children.length + ' resposta' + (children.length===1?"":"s") + '</button>' : '') +
    (canDelete ? '<button type="button" class="comment-action comment-delete-action" data-comment-delete="' + id + '">Excluir</button>' : '') +
    '<time class="comment-date" datetime="' + escapeHTML(comment.created_at || "") + '">' + escapeHTML(readerCommentDate(comment.created_at)) + '</time></div>' +
    '<div class="comment-replies" data-comment-replies="' + id + '" hidden>' + replies + '</div></article>';
}
function linkReaderCommentMentions(root) {
  const pattern = /@([A-Za-z0-9_]{3,24})/g;
  root.querySelectorAll("p").forEach(paragraph=>{
    const source=paragraph.textContent || "";
    let match,cursor=0,found=false;
    pattern.lastIndex=0;
    const fragment=document.createDocumentFragment();
    while((match=pattern.exec(source))){
      found=true;
      fragment.appendChild(document.createTextNode(source.slice(cursor,match.index)));
      const link=document.createElement("a");
      link.className="comment-mention";link.href=readerProfileHref(match[1]);link.target="_blank";link.rel="noopener noreferrer";link.textContent=match[0];
      fragment.appendChild(link);cursor=match.index+match[0].length;
    }
    if(!found)return;
    fragment.appendChild(document.createTextNode(source.slice(cursor)));
    paragraph.replaceChildren(fragment);
  });
}
function renderReaderCommentThread(list,thread) {
  if(thread.error){list.innerHTML='<span class="section-subtitle">Não foi possível carregar os comentários.</span>';console.error("[ComicReader] Falha ao carregar comentários:",thread.error);return;}
  const byParent=new Map();
  thread.comments.forEach(comment=>{
    const parent=comment.parent_id==null?null:Number(comment.parent_id);
    if(!byParent.has(parent))byParent.set(parent,[]);
    byParent.get(parent).push(comment);
  });
  list.innerHTML=(byParent.get(null)||[]).map(comment=>readerCommentMarkup(comment,byParent,thread.likedIds,thread.counts)).join("")
    || '<span class="section-subtitle">Nenhum comentário ainda.</span>';
  linkReaderCommentMentions(list);
}
function readerCommentWriteError(error) {
  const message=String(error?.message || "");
  return /row-level security|permission denied|can_post_content|silenced|blocked/i.test(message)
    ? "Sua conta não pode comentar neste momento."
    : "Não foi possível publicar o comentário.";
}
function bindReaderCommentThread(root,item,list,refresh) {
  if(root.dataset.readerCommentThreadBound==="true")return;
  root.dataset.readerCommentThreadBound="true";
  root.addEventListener("click",async event=>{
    const likeButton=event.target.closest("[data-comment-like]");
    if(likeButton){
      event.preventDefault();
      try{
        const client=await ensureSupabaseClient(),userId=state.session?.user?.id;
        if(!userId)return readerAskLogin();
        const commentId=Number(likeButton.dataset.commentLike),liked=likeButton.classList.contains("is-liked");
        const result=liked
          ? await client.from("comment_likes").delete().eq("user_id",userId).eq("comment_id",commentId)
          : await client.from("comment_likes").insert({user_id:userId,comment_id:commentId});
        if(result.error)throw result.error;
        await refresh();
      }catch(error){console.error("[ComicReader] Curtida de comentário:",error);readerActionToast("Não foi possível atualizar a curtida.");}
      return;
    }
    const deleteButton=event.target.closest("[data-comment-delete]");
    if(deleteButton){
      event.preventDefault();
      if(!window.confirm("Excluir este comentário e suas respostas?"))return;
      deleteButton.disabled=true;
      try{
        const result=await (await ensureSupabaseClient()).from("comments").delete().eq("id",Number(deleteButton.dataset.commentDelete));
        if(result.error)throw result.error;
        readerActionToast("Comentário excluído.");await refresh();
      }catch(error){console.error("[ComicReader] Exclusão de comentário:",error);readerActionToast("Não foi possível excluir o comentário.");deleteButton.disabled=false;}
      return;
    }
    const toggle=event.target.closest("[data-comment-toggle]");
    if(toggle){
      const replies=root.querySelector('[data-comment-replies="' + toggle.dataset.commentToggle + '"]');
      if(replies){replies.hidden=!replies.hidden;toggle.textContent=replies.hidden?"Ver respostas":"Ocultar respostas";}
      return;
    }
    const reply=event.target.closest("[data-comment-reply]");
    if(reply){
      const comment=root.querySelector('[data-comment-id="' + reply.dataset.commentReply + '"]');
      if(!comment||comment.querySelector("[data-reply-form]"))return;
      if(!state.session?.user?.id){readerAskLogin();return;}
      const form=document.createElement("form");
      form.className="comment-form comment-reply-form";form.dataset.replyForm="true";
      form.innerHTML='<textarea name="body" maxlength="1000" required placeholder="Escreva uma resposta..."></textarea><button class="small-btn" type="submit">Responder</button>';
      comment.appendChild(form);form.querySelector("textarea")?.focus();
    }
  });
  root.addEventListener("submit",async event=>{
    const form=event.target.closest("[data-reply-form]");
    if(!form)return;
    event.preventDefault();
    const userId=state.session?.user?.id;
    if(!userId)return readerAskLogin();
    const body=String(new FormData(form).get("body")||"").trim();
    if(!body)return;
    const parentId=Number(form.closest("[data-comment-id]")?.dataset.commentId);
    const button=form.querySelector("button");if(button)button.disabled=true;
    try{
      const result=await (await ensureSupabaseClient()).from("comments").insert({user_id:userId,item_id:String(item.id),parent_id:parentId,body});
      if(result.error)throw result.error;
      form.remove();await refresh();
    }catch(error){console.error("[ComicReader] Resposta:",error);readerActionToast(readerCommentWriteError(error));if(button)button.disabled=false;}
  });
}
async function submitReaderCommentForm(form,item,refresh) {
  const userId=state.session?.user?.id;
  if(!userId)return readerAskLogin();
  const body=String(new FormData(form).get("body")||"").trim();
  if(!body)return;
  const button=form.querySelector("button");if(button)button.disabled=true;
  try{
    const result=await (await ensureSupabaseClient()).from("comments").insert({user_id:userId,item_id:String(item.id),body});
    if(result.error)throw result.error;
    form.reset();readerActionToast("Comentário publicado.");await refresh();
  }catch(error){console.error("[ComicReader] Publicação:",error);readerActionToast(readerCommentWriteError(error));if(button)button.disabled=false;}
}
async function openCommentsPopup(item) {
  if(!item?.id)return;
  const overlay=document.createElement("div");
  overlay.className="modal-backdrop comments-modal-backdrop";overlay.style.zIndex="100001";
  overlay.innerHTML='<div class="modal comments-modal"><div class="section-head"><div><h2>Comentários</h2><div class="section-subtitle">' + escapeHTML(itemDisplayTitle(item)) + '</div></div><button class="small-btn" data-close type="button">Fechar</button></div><div class="comments-list"><span class="section-subtitle">Carregando...</span></div>' +
    (state.session?.user?.id?'<form class="comment-form"><textarea name="body" maxlength="1000" required placeholder="Escreva um comentário..."></textarea><button class="small-btn" type="submit">Comentar</button></form>':'<p class="section-subtitle">Entre para comentar.</p><a class="comment-mention" target="_blank" rel="noopener noreferrer" href="' + readerLoginUrl() + '">Abrir a Banca Digital para entrar</a>') + '</div>';
  (document.querySelector("#modal-root")||document.body).appendChild(overlay);
  const close=()=>overlay.remove();
  overlay.addEventListener("click",event=>{if(event.target===overlay)close();});
  overlay.querySelector("[data-close]")?.addEventListener("click",close);
  const list=overlay.querySelector(".comments-list");
  const refresh=async()=>renderReaderCommentThread(list,await loadReaderCommentThread(item));
  bindReaderCommentThread(overlay,item,list,refresh);
  const form=overlay.querySelector(".comment-form");
  form?.addEventListener("submit",event=>{event.preventDefault();void submitReaderCommentForm(form,item,refresh);});
  await refresh();
}
function seriesIssueSortValue(item) {
  if(Number.isFinite(item?.seriesSortOrder))return -1000000000+item.seriesSortOrder;
  const explicitOrder=Number(item?.sortOrder);
  if(Number.isFinite(explicitOrder))return explicitOrder;
  const issueNumber=Number(String(item?.issue||"").match(/\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(issueNumber)?issueNumber:Number.MAX_SAFE_INTEGER;
}
function seriesIssueDisplay(item) {
  const issue=String(item?.issue??"").trim();
  if(item?.seriesId==="series-action-comics-2011-novos-52")return ({"2012":"Anual 01","2013":"Anual 02","2014":"Anual 03"})[issue]||issue;
  return issue;
}
function seriesEditions(item) {
  if(!item?.seriesId)return [];
  const all=Array.isArray(window.DEFAULT_LIBRARY)?window.DEFAULT_LIBRARY:[];
  return [...new Map(all.filter(entry=>String(entry?.seriesId||"")===String(item.seriesId)).map(entry=>[String(entry.id),entry])).values()]
    .sort((a,b)=>seriesIssueSortValue(a)-seriesIssueSortValue(b));
}
async function loadReaderCatalogSources() {
  for(const path of CATALOG_SCRIPTS){
    try{await loadBancaScript(path);}
    catch(error){console.warn("[ComicReader] Fonte de catálogo indisponível:",path,error);}
  }
}
function readerCoverCandidates(item) {
  const seriesId=String(item?.seriesId||"");
  const series=(window.DEFAULT_SERIES||[]).find(entry=>String(entry?.id||"")===seriesId)||null;
  const defaultCover=window.BancaSeriesDefaults?.get?.(seriesId)||null;
  const values=[item?.coverUrl,item?.cover,item?.featuredCoverUrl,defaultCover?.cover_url,series?.coverUrl,series?.cover,series?.featuredCoverUrl];
  const urls=[];
  for(let value of values){
    if(value&&typeof value==="object")value=value.url||value.src||value.coverUrl||value.cover_url||"";
    const raw=String(value||"").trim();
    if(!raw)continue;
    try{
      let url;
      if(/^(?:https?:|data:|blob:)/i.test(raw)||raw.startsWith("//"))url=new URL(raw,BANCADIGITAL_BASE);
      else {
        const relative=raw.startsWith("/")?raw.split("/").filter(Boolean).join("/"):raw;
        url=new URL(relative,BANCADIGITAL_BASE);
      }
      if(!/^(?:https?:|data:|blob:)$/.test(url.protocol))continue;
      if(!urls.includes(url.href))urls.push(url.href);
    }catch{}
  }
  return urls;
}
function readerSeriesCardMarkup(item) {
  const issue=seriesIssueDisplay(item);
  const issueLabel=issue?(/^\d+(?:\.\d+)?$/.test(issue)?"#"+issue:issue):"";
  const title=String(item?.title||item?.name||item?.seriesTitle||"Quadrinho");
  const meta=[item.year,item.publisher,item.imprint].filter(Boolean).map(value=>'<span>'+escapeHTML(value)+'</span>').join("");
  return '<div class="card-wrap"><article class="card reader-series-card" data-reader-series-edition="'+escapeHTML(item.id)+'">' +
    '<div class="cover"><img class="reader-series-cover-image" data-reader-series-cover="'+escapeHTML(item.id)+'" alt="" aria-hidden="true" loading="lazy" decoding="async" hidden style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0"><div class="cover-labels">'+(issueLabel?'<span class="cover-number">'+escapeHTML(issueLabel)+'</span>':'')+'</div></div>' +
    '<div class="card-body"><div class="card-title">'+escapeHTML(title)+'</div><div class="card-meta">'+meta+'</div><div class="card-stats"><span>'+escapeHTML(item.year||"")+'</span></div></div></article></div>';
}
function attachReaderSeriesCoverImages(root,list) {
  const byId=new Map(list.map(item=>[String(item?.id||""),item]));
  root.querySelectorAll("[data-reader-series-cover]").forEach(image=>{
    const item=byId.get(String(image.dataset.readerSeriesCover||""));
    const candidates=readerCoverCandidates(item);
    if(!candidates.length){image.remove();return;}
    let nextIndex=0;
    const tryNext=()=>{
      if(nextIndex>=candidates.length){image.remove();return;}
      image.hidden=false;
      image.src=candidates[nextIndex++];
    };
    image.addEventListener("error",tryNext);
    tryNext();
  });
}
async function openSeriesSelection(series, editions=[], returnToCoverVariants=false, returnToFileReports=false, returnToReader=null, allowHiddenPreview=false, forcePage=false) {
  const seriesId=String(series?.seriesId||series?.id||"");
  const existing=document.querySelector("[data-reader-series-dialog]");
  existing?.remove();

  const overlay=document.createElement("div");
  overlay.className="modal-backdrop";
  overlay.dataset.readerSeriesDialog="true";
  overlay.style.zIndex="100001";
  const seriesRecord=()=>((window.DEFAULT_SERIES||[]).find(entry=>String(entry.id)===seriesId)||null);
  const initialTitle=String(series?.seriesTitle||series?.title||series?.name||seriesRecord()?.title||"Série");
  overlay.innerHTML='<div class="modal series-modal"><div class="section-head"><div><div class="eyebrow">Série</div><h2 data-series-title>'+escapeHTML(initialTitle)+'</h2><div class="section-subtitle" data-series-count>Carregando edições…</div></div><div class="modal-actions">'+
    '<button class="small-btn" data-back-cover-variants '+(returnToCoverVariants?"":"hidden")+' type="button">Voltar</button>'+
    '<button class="small-btn" data-back-file-reports '+(returnToFileReports?"":"hidden")+' type="button">Voltar</button>'+
    '<button class="small-btn" data-back-reader '+(returnToReader?"":"hidden")+' type="button">Voltar à história</button>'+
    '<button class="small-btn" data-close type="button">Fechar</button></div></div>'+
    '<div data-series-content><p class="section-subtitle">Carregando as edições desta série…</p></div></div>';
  (document.querySelector("#modal-root")||document.body).appendChild(overlay);

  let closed=false;
  const close=()=>{if(closed)return;closed=true;document.removeEventListener("keydown",onKeyDown);overlay.remove();};
  const onKeyDown=event=>{if(event.key==="Escape"&&overlay.isConnected){event.preventDefault();close();}};
  document.addEventListener("keydown",onKeyDown);
  overlay.addEventListener("click",event=>{if(event.target===overlay)close();});
  overlay.querySelector("[data-close]")?.addEventListener("click",close);
  // A edição permanece aberta atrás do modal. Voltar apenas fecha a seleção;
  // não recarrega a história nem altera a rota atual.
  overlay.querySelector("[data-back-reader]")?.addEventListener("click",close);
  overlay.querySelector("[data-back-cover-variants]")?.addEventListener("click",()=>{close();readerActionToast("Abra a seleção de capas pela página da Banca Digital.");});
  overlay.querySelector("[data-back-file-reports]")?.addEventListener("click",()=>{close();readerActionToast("Abra os relatórios pela página da Banca Digital.");});
  overlay.querySelector("[data-close]")?.focus();

  const content=overlay.querySelector("[data-series-content]");
  const countLabel=overlay.querySelector("[data-series-count]");
  const renderList=()=>{
    if(closed||!overlay.isConnected)return;
    const loaded=seriesEditions({seriesId});
    const merged=new Map();
    for(const entry of (Array.isArray(editions)?editions:[]))if(entry?.id)merged.set(String(entry.id),entry);
    for(const entry of loaded)if(entry?.id)merged.set(String(entry.id),{...(merged.get(String(entry.id))||{}),...entry});
    const list=[...merged.values()].sort((a,b)=>seriesIssueSortValue(a)-seriesIssueSortValue(b));
    const title=String(seriesRecord()?.title||series?.seriesTitle||series?.title||series?.name||"Série");
    overlay.querySelector("[data-series-title]").textContent=title;
    if(!list.length){
      countLabel.textContent="Nenhuma edição encontrada";
      content.innerHTML='<p class="section-subtitle">Não foi possível encontrar as edições desta série no catálogo carregado. Feche e tente novamente.</p>';
      return;
    }
    countLabel.textContent=list.length+" edições · selecione uma edição para abrir";
    const volumes=new Map();
    list.forEach(entry=>{const label=entry.volumeTitle||entry.volume||"Edições";if(!volumes.has(label))volumes.set(label,[]);volumes.get(label).push(entry);});
    const volumeEntries=[...volumes.entries()];
    const tabs=volumeEntries.length>1
      ? '<div class="series-volume-tabs">'+volumeEntries.map((entry,index)=>'<button class="small-btn '+(index===0?"is-active":"")+'" type="button" data-series-volume-tab="'+index+'">'+escapeHTML(entry[0])+'</button>').join("")+'</div>'
      : "";
    const panels=volumeEntries.map((entry,index)=>'<div class="series-volume-panel" data-series-volume-panel="'+index+'" '+(index?"hidden":"")+'><div class="section-subtitle series-volume-heading">'+escapeHTML(entry[0])+'</div><div class="results-grid">'+entry[1].map(readerSeriesCardMarkup).join("")+'</div></div>').join("");
    content.innerHTML=tabs+panels;
    attachReaderSeriesCoverImages(content,list);
    content.querySelectorAll("[data-series-volume-tab]").forEach(tab=>tab.addEventListener("click",()=>{
      const selected=tab.dataset.seriesVolumeTab;
      content.querySelectorAll("[data-series-volume-tab]").forEach(button=>button.classList.toggle("is-active",button===tab));
      content.querySelectorAll("[data-series-volume-panel]").forEach(panel=>{panel.hidden=panel.dataset.seriesVolumePanel!==selected;});
    }));
    content.querySelectorAll("[data-reader-series-edition]").forEach(card=>{
      card.tabIndex=0;card.setAttribute("role","button");
      const open=()=>{
        const target=list.find(entry=>String(entry.id)===String(card.dataset.readerSeriesEdition));
        if(!target)return;
        close();
        // Always reload through the official edition resolver so Supabase overrides,
        // Telegram pages, and the canonical source are used instead of stale catalog data.
        void openBancaEditionLink(readerCanonicalShareUrl(target.id)).catch(error=>{
          console.error("[ComicReader] Não foi possível abrir a edição da série:",error);
          // Se a próxima edição falhar, preserve a que já estava aberta.
          readerActionToast(error?.message||"Não foi possível abrir esta edição.");
        });
      };
      card.addEventListener("click",open);
      card.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();open();}});
    });
  };

  // Show the modal immediately, then resolve the catalog in the background. The
  // previous implementation waited for every large catalog script before showing UI.
  renderList();
  void loadReaderCatalogSources().then(renderList).catch(error=>{
    console.warn("[ComicReader] Falha ao carregar o catálogo completo da série:",error);
    renderList();
  });
}
function openEditForm() { readerActionToast("Edite os metadados pelo catálogo da Banca Digital."); }
function openEntityPage(kind,value) {
  const url=new URL(BANCADIGITAL_BASE);
  if(kind==="character")url.searchParams.set("personagem",String(value||""));
  else if(kind==="publisher")url.searchParams.set("editora",String(value||""));
  window.open(url.href,"_blank","noopener,noreferrer");
}
function attachComments(item,overlay) {
  if(!sb||state.session?.offline||navigator.onLine===false||item.local)return;
  const panel=$("[data-reader-comments-panel]",overlay);
  const toggle=$("[data-reader-comments-toggle]",overlay);
  if(!panel||!toggle)return;
  panel.className="reader-comments";
  panel.innerHTML='<div class="comments-content"><div class="comments-list"><span class="section-subtitle">Carregando...</span></div>'+
    (state.session?.user?.id?'<form class="comment-form"><textarea name="body" maxlength="1000" required placeholder="Escreva um comentário..."></textarea><button class="small-btn" type="submit">Comentar</button></form>':
    '<p class="section-subtitle">Entre para comentar.</p><a class="comment-mention" target="_blank" rel="noopener noreferrer" href="'+readerLoginUrl()+'">Abrir a Banca Digital para entrar</a>')+'</div>';
  toggle.onclick=event=>{
    event.preventDefault();event.stopPropagation();
    const opening=panel.hidden;
    panel.hidden=!opening;
    toggle.textContent=opening?"− Comentários":"＋ Comentários";
    toggle.setAttribute("aria-expanded",opening?"true":"false");
  };
  const list=$(".comments-list",panel);
  const refresh=async()=>renderReaderCommentThread(list,await loadReaderCommentThread(item));
  bindReaderCommentThread(panel,item,list,refresh);
  const form=$(".comment-form",panel);
  form?.addEventListener("submit",event=>{event.preventDefault();void submitReaderCommentForm(form,item,refresh);});
  void refresh();
}
async function refreshComicEngagement(item,overlay) {
  if(!item||item.local||!overlay)return;
  const button=overlay.querySelector("[data-like-item]");if(!button)return;
  try{
    const client=await ensureSupabaseClient(),id=String(item.id);
    const {count,error}=await client.from("comic_likes").select("user_id",{count:"exact",head:true}).eq("item_id",id);
    if(error)throw error;
    const userId=state.session?.user?.id;
    let liked=false;
    if(userId){
      const {data,error:likeError}=await client.from("comic_likes").select("item_id").eq("item_id",id).eq("user_id",userId).maybeSingle();
      if(likeError)throw likeError;liked=Boolean(data);
    }
    state.comicLikeCounts.set(id,Number(count)||0);
    if(liked)state.comicLikeIds.add(id);else state.comicLikeIds.delete(id);
    updateComicLikeButtons(id);
  }catch(error){console.warn("[ComicReader] Falha ao carregar curtidas:",error);}
}
function appendSeriesNavigation(item,controls,overlay) {
  const previousHost=$("#reader-series-prev",overlay),nextHost=$("#reader-series-next",overlay);
  if(!previousHost&&!nextHost)return;
  const render=()=>{
    if(!overlay?.isConnected)return;
    const editions=seriesEditions(item),current=editions.findIndex(entry=>String(entry.id)===String(item.id));
    previousHost?.replaceChildren();nextHost?.replaceChildren();
    if(current<0)return;
    const label=entry=>{const issue=seriesIssueDisplay(entry);return issue?(/^\d+(?:\.\d+)?$/.test(issue)?"#"+issue:issue):"Edição";};
    const add=(host,html)=>{
      if(!host)return;
      const nav=document.createElement("span");nav.dataset.seriesNav="true";nav.className="series-reader-nav";nav.innerHTML=html;host.appendChild(nav);
      nav.querySelectorAll("[data-series-target]").forEach(button=>button.addEventListener("click",()=>{
        const target=editions[Number(button.dataset.seriesTarget)];
        if(target&&String(target.id)!==String(item.id))void openBancaEditionLink(readerCanonicalShareUrl(target.id)).catch(error=>showEmptyReader(error?.message||"Não foi possível abrir esta edição."));
      }));
    };
    if(current>0){
      const first=editions[0],prev=editions[current-1];
      add(previousHost,(current>1?'<button type="button" title="Primeira edição" data-series-target="0">« '+escapeHTML(label(first))+'</button>':"")+
        '<button type="button" title="Edição anterior" data-series-target="'+(current-1)+'">‹ '+escapeHTML(label(prev))+'</button>');
    }
    if(current<editions.length-1){
      const next=editions[current+1],last=editions[editions.length-1];
      add(nextHost,'<button type="button" title="Próxima edição" data-series-target="'+(current+1)+'">'+escapeHTML(label(next))+' ›</button>'+
        (current<editions.length-2?'<button type="button" title="Última edição" data-series-target="'+(editions.length-1)+'">'+escapeHTML(label(last))+' »</button>':""));
    }
  };
  render();
  if(!overlay._completeSeriesCatalogPromise){
    overlay._completeSeriesCatalogPromise=loadReaderCatalogSources().catch(()=>{});
    void overlay._completeSeriesCatalogPromise.then(render);
  }else void overlay._completeSeriesCatalogPromise.then(render);
}
function resumeCoverLoading() {}
function setReadingMode(mode) {
  state.readingMode = mode;
  try {localStorage.setItem("readingMode", mode);} catch {}
}
function setReadingDirection(direction) {
  state.readingDirection = direction;
  try {localStorage.setItem("readingDirection", direction);} catch {}
}
async function reportFileFailure(item, message, options = {}) {
  console.error("Leitor:", item?.title || item?.id || "", message);
  if (!options.silent) toast(message);
}
function loadReaderAdsFeature() {
  return Promise.resolve({createReaderController: () => null});
}
async function parseEditionPayload() {
  let edition = {};
  const decode = value => {
    try {
      const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(normalized);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (firstError) {
      try { return JSON.parse(decodeURIComponent(String(value))); } catch { throw firstError; }
    }
  };
  if (params.has("data")) {
    const value = params.get("data");
    edition = Object.assign(edition, value.trim().startsWith("{") ? JSON.parse(value) : decode(value));
  }
  if (params.has("manifest")) {
    const response = await fetch(params.get("manifest"), {cache:"no-store"});
    if (!response.ok) throw new Error("Não foi possível carregar os dados desta edição.");
    edition = Object.assign(edition, await response.json());
  }
  if (params.has("src")) edition.sourceUrl = params.get("src");
  if (params.has("title")) edition.title = params.get("title");
  if (params.has("format")) edition.format = params.get("format");
  if (params.has("pages")) edition.pages = decode(params.get("pages"));
  return edition;
}
function usableTelegramImageUrl(value) {
  const url = String(typeof value === "string" ? value : value?.imageUrl || value?.src || value?.url || "").trim();
  // Telegram post permalinks are not raw images: render via telegram-page-image.
  return /^https?:\/\//i.test(url) && !isTelegramPostUrl(url) ? url : "";
}
function normalizeItem(edition) {
  const originalTelegramPages = Array.isArray(edition.telegramPages) && edition.telegramPages.length
    ? edition.telegramPages
    : undefined;
  // A migrated edition stores telegramPages[].url as a t.me post permalink,
  // not as an image file. Do not use the permalink as an img src; route those
  // pages through the telegram-page-image endpoint instead.
  activePageUrls = Array.isArray(edition.pages)
    ? edition.pages.map(usableTelegramImageUrl).filter(Boolean)
    : [];
  if (!activePageUrls.length && Array.isArray(edition.telegramPages)) {
    activePageUrls = edition.telegramPages.map(usableTelegramImageUrl).filter(Boolean);
  }
  if (!activePageUrls.length && edition.telegramItemId && edition.telegramBaseUrl && Number(edition.pageCount) > 0) {
    const base = String(edition.telegramBaseUrl).replace(/\/+$/, "");
    activePageUrls = Array.from({length: Math.min(5000, Number(edition.pageCount))}, (_, index) => {
      const u = new URL(base + "/functions/v1/telegram-page-image");
      u.searchParams.set("item_id", String(edition.telegramItemId));
      u.searchParams.set("page", String(index + 1));
      return u.href;
    });
  }
  const sourceUrl = String(edition.fileUrl || edition.url || edition.sourceUrl || "");
  const id = String(edition.id || edition.telegramItemId || "external-edition");
  activeEditionForPageUrls = id;
  window.BancaTelegramPages = {
    imageUrl(itemId, pageNumber) {
      const index = Number(pageNumber) - 1;
      if (String(itemId) !== String(activeEditionForPageUrls) || index < 0) return "";
      if (activePageUrls[index]) return activePageUrls[index];
      const base = String(edition.telegramBaseUrl || window.BANCA_SUPABASE_URL || "").replace(/\/+$/, "");
      if (!base) return "";
      const url = new URL(base + "/functions/v1/telegram-page-image");
      url.searchParams.set("item_id", String(itemId));
      url.searchParams.set("page", String(pageNumber));
      return url.href;
    }
  };
  const isImagePages = activePageUrls.length > 0;
  const format = isImagePages ? "telegram-pages" : String(edition.format || extension(sourceUrl)).toLowerCase();
  return {
    ...edition,
    id, title: String(edition.title || edition.name || "Quadrinho"),
    sourceUrl, fileUrl: sourceUrl, backupUrls: edition.backupUrls || [],
    format, local: false,
    telegramPages: isImagePages ? activePageUrls.map((url, index) => ({page:index + 1, url})) : originalTelegramPages
  };
}
function showEmptyReader(message) {
  const body = $("#reader-body");
  const title = $("#editionTitle");
  const counter = $("#reader-controls");
  if (title) title.textContent = "Leitor de quadrinhos";
  if (counter) counter.innerHTML = '<button id="previous" type="button" aria-label="Página anterior" disabled>‹</button><span class="reader-page">— / —</span><button id="next" type="button" aria-label="Próxima página" disabled>›</button>';
  if (!body) return;

  const panel = document.createElement("div");
  panel.className = "empty";
  panel.style.cssText = "width:calc(100% - 32px);max-width:650px;margin:auto;padding:28px 20px;text-align:center;box-sizing:border-box";

  const heading = document.createElement("h2");
  heading.textContent = "Abrir edição no leitor";
  heading.style.cssText = "margin:0 0 10px;color:#f1f1f3";

  const description = document.createElement("p");
  description.textContent = message || "Escolha um arquivo do computador ou cole o link de uma edição da Banca Digital.";
  description.style.cssText = "margin:0 auto 16px;max-width:520px;color:#b7b7bf";

  const formats = document.createElement("p");
  formats.textContent = "Arquivos aceitos: PDF, CBZ, CBR, JPG, PNG, WEBP e GIF.";
  formats.style.cssText = "margin:0 auto 18px;color:#92929b;font-size:12px";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.id = "local-comic-file";
  fileInput.accept = ".pdf,.cbz,.cbr,.jpg,.jpeg,.png,.webp,.gif,application/pdf,image/jpeg,image/png,image/webp,image/gif";
  fileInput.setAttribute("aria-label", "Escolher arquivo de quadrinho");
  fileInput.style.cssText = "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";

  const chooseButton = document.createElement("button");
  chooseButton.type = "button";
  chooseButton.className = "btn btn-primary";
  chooseButton.textContent = "Escolher arquivo do computador";
  chooseButton.style.cssText = "display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:10px 18px;cursor:pointer";
  chooseButton.addEventListener("click", () => fileInput.click());

  const fileStatus = document.createElement("div");
  fileStatus.style.cssText = "margin-top:10px;color:#b7b7bf;font-size:12px;overflow-wrap:anywhere";
  fileStatus.textContent = "O arquivo é aberto no navegador e não é enviado a um servidor.";

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    fileStatus.textContent = "Abrindo " + file.name + "…";
    chooseButton.disabled = true;
    void openLocalComicFile(file).catch(error => {
      chooseButton.disabled = false;
      fileStatus.textContent = error?.message || "Não foi possível abrir esse arquivo.";
    });
  });

  const separator = document.createElement("div");
  separator.style.cssText = "height:1px;background:#303036;margin:22px auto;max-width:480px";

  const linkHeading = document.createElement("h3");
  linkHeading.textContent = "Ou cole o link da edição da Banca Digital";
  linkHeading.style.cssText = "margin:0 0 10px;color:#f1f1f3;font-size:15px";

  const linkForm = document.createElement("form");
  linkForm.style.cssText = "display:flex;flex-direction:column;gap:10px;width:100%;max-width:500px;margin:0 auto";
  const linkInput = document.createElement("input");
  linkInput.type = "url";
  linkInput.id = "banca-edition-link";
  linkInput.placeholder = "https://uriel29m.github.io/bancadigital/?ler=...";
  linkInput.autocomplete = "url";
  linkInput.spellcheck = false;
  linkInput.setAttribute("aria-label", "Link da edição na Banca Digital");
  linkInput.style.cssText = "box-sizing:border-box;width:100%;min-height:42px;padding:10px 12px;border:1px solid #44444c;border-radius:7px;background:#151519;color:#f1f1f3;font:inherit";
  const linkButton = document.createElement("button");
  linkButton.type = "submit";
  linkButton.className = "btn btn-primary";
  linkButton.textContent = "Abrir link no leitor";
  linkButton.style.cssText = "min-height:42px;padding:10px 18px;cursor:pointer";
  const linkStatus = document.createElement("div");
  linkStatus.id = "banca-link-status";
  linkStatus.setAttribute("role", "status");
  linkStatus.setAttribute("aria-live", "polite");
  linkStatus.style.cssText = "min-height:18px;color:#b7b7bf;font-size:12px;overflow-wrap:anywhere";
  linkForm.append(linkInput, linkButton, linkStatus);
  linkForm.addEventListener("submit", event => {
    event.preventDefault();
    linkButton.disabled = true;
    linkStatus.textContent = "Localizando edição e preparando o leitor…";
    void openBancaEditionLink(linkInput.value).then(() => {
      linkStatus.textContent = "";
    }).catch(error => {
      linkStatus.textContent = error?.message || "Não foi possível abrir essa edição.";
      linkButton.disabled = false;
    });
  });

  panel.append(heading, description, formats, fileInput, chooseButton, fileStatus, separator, linkHeading, linkForm);
  body.replaceChildren(panel);
  body.classList.remove("continuous", "reader-grayscale", "reader-gesture-zoom");
  body.style.removeProperty("--reader-zoom");
  body.style.removeProperty("--reader-pan-x");
  body.style.removeProperty("--reader-pan-y");
}
async function openLocalComicFile(file) {
  const format = extension(file?.name || "");
  const supported = ["pdf", "cbz", "cbr", "jpg", "jpeg", "png", "webp", "gif"];
  if (!file || !supported.includes(format)) {
    showEmptyReader("Esse formato não é compatível. Escolha um PDF, CBZ, CBR ou arquivo de imagem.");
    return;
  }

  const objectUrl = URL.createObjectURL(file);
  const item = {
    id: "local-file-" + Date.now(),
    title: file.name.replace(/\.[^.]+$/, "") || file.name,
    name: file.name,
    fileName: file.name,
    format,
    file,
    fileUrl: objectUrl,
    sourceUrl: objectUrl,
    local: true,
    backupUrls: []
  };

  try {
    state.readerItemId = item.id;
    readerIsOpen = false;
    activeReaderCleanup?.();
    activeReaderCleanup = null;
    // Mantém a tela de seleção sob o leitor para que "Voltar" retorne ao seletor.
    openReader(item, {routeSync: true, localObjectUrl: objectUrl});
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

const catalogScriptLoads = new Map();
const CATALOG_SCRIPTS = [
  "js/data/dc-comics/recentes.js?v=2.2.7.54",
  "js/data/dc-comics/black-label.js?v=1.0.14",
  "js/data/dc-comics/milestone.js?v=1.1.1",
  "js/data/dc-comics/novos-52.js?v=1.0.26",
  "js/catalog-identity.js?v=1"
];
function loadBancaScript(pathOrUrl) {
  const src = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : new URL(pathOrUrl, BANCADIGITAL_BASE).href;
  if (catalogScriptLoads.has(src)) return catalogScriptLoads.get(src);
  const alreadyPresent = Array.from(document.scripts).some(script => script.src === src);
  if (alreadyPresent && (src.includes("reader-deps.js") || src.includes("supabase.js"))) return Promise.resolve();
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      catalogScriptLoads.delete(src);
      reject(new Error("Não foi possível carregar " + new URL(src).pathname.split("/").pop() + " da Banca Digital."));
    };
    document.head.appendChild(script);
  });
  catalogScriptLoads.set(src, promise);
  return promise;
}
let readerProfileLoadedFor = null;
async function syncReaderAuthState(client) {
  const {data, error} = await client.auth.getSession();
  if (error) throw error;
  state.session = data?.session || null;
  const userId = String(state.session?.user?.id || "");
  if (!userId) {
    state.profile = null;
    readerProfileLoadedFor = null;
    return;
  }
  if (readerProfileLoadedFor !== userId) {
    const {data: profile, error: profileError} = await client
      .from("profiles")
      .select("id,username,avatar_url,plan")
      .eq("id", userId)
      .maybeSingle();
    state.profile = profileError ? null : (profile || null);
    readerProfileLoadedFor = userId;
  }
}
async function ensureSupabaseClient() {
  if (!sb) {
    if (!window.supabase?.createClient) {
      await loadBancaScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
    }
    if (!window.BANCA_SUPABASE_URL || !window.BANCA_SUPABASE_KEY) {
      await loadBancaScript("js/supabase.js");
    }
    if (!window.supabase?.createClient || !window.BANCA_SUPABASE_URL || !window.BANCA_SUPABASE_KEY) {
      throw new Error("Não foi possível conectar ao catálogo da Banca Digital.");
    }
    sb = window.supabase.createClient(window.BANCA_SUPABASE_URL, window.BANCA_SUPABASE_KEY, {
      auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true}
    });
  }
  await syncReaderAuthState(sb);
  return sb;
}
function parseBancaEditionId(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Cole o link de uma edição da Banca Digital.");
  // Aceita também o ID cru da edição, além do link completo.
  if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,180}$/.test(raw) && !raw.includes("://")) return raw;
  let url;
  try { url = new URL(raw, BANCADIGITAL_BASE); }
  catch { throw new Error("Link inválido. Cole a URL completa da edição."); }
  if (url.hostname.toLowerCase() !== "uriel29m.github.io" ||
      !/^\/bancadigital\/?$/.test(url.pathname)) {
    throw new Error("Use o link da edição na Banca Digital, no formato https://uriel29m.github.io/bancadigital/?ler=ID.");
  }
  const id = url.searchParams.get("ler") || url.searchParams.get("edicao") || url.searchParams.get("id");
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,180}$/.test(id)) {
    throw new Error("Esse link não identifica uma edição. Copie o endereço da edição aberta na Banca Digital (ele deve conter ?ler=...).");
  }
  return id;
}
async function findStaticBancaEdition(id) {
  for (const path of CATALOG_SCRIPTS) {
    if (path.split("?")[0] === "js/catalog-identity.js") {
      if (!window.__comicReaderCatalogIdentityLoaded) {
        try { await loadBancaScript(path); } catch (error) { console.warn(error); }
        window.__comicReaderCatalogIdentityLoaded = true;
      }
    } else {
      await loadBancaScript(path);
    }
    const found = Array.isArray(window.DEFAULT_LIBRARY)
      ? window.DEFAULT_LIBRARY.find(item => String(item?.id || "") === String(id))
      : null;
    if (found) {
      // Identity normalization is safe and keeps the official series IDs intact.
      if (!window.__comicReaderCatalogIdentityLoaded) {
        try { await loadBancaScript(CATALOG_SCRIPTS.find(script => script.split("?")[0] === "js/catalog-identity.js") || "js/catalog-identity.js?v=1"); } catch (error) { console.warn(error); }
        window.__comicReaderCatalogIdentityLoaded = true;
      }
      return (window.DEFAULT_LIBRARY || []).find(item => String(item?.id || "") === String(id)) || found;
    }
  }
  return Array.isArray(window.DEFAULT_LIBRARY)
    ? window.DEFAULT_LIBRARY.find(item => String(item?.id || "") === String(id)) || null
    : null;
}
const CATALOG_OVERRIDE_FIELDS = [
  "coverUrl", "cover", "featuredCoverUrl", "fileUrl", "telegramUrl", "telegramFileId",
  "telegramFileName", "telegramFileSize", "backupUrls", "telegramPages",
  "telegramPageFiles", "telegramPagesPending", "telegramPagesMigration", "format"
];
function mergeCatalogEdition(baseItem, edition) {
  const merged = {...(baseItem || {}), ...(edition || {})};
  for (const field of CATALOG_OVERRIDE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(edition || {}, field)) merged[field] = edition[field];
    else delete merged[field];
  }
  return merged;
}
async function loadCatalogOverride(id) {
  const client = await ensureSupabaseClient();
  const {data, error} = await client
    .from("catalog_edition_overrides")
    .select("item_id,edition,created_at,updated_at")
    .eq("item_id", String(id))
    .maybeSingle();
  if (error) throw error;
  if (!data?.edition) return null;
  if (String(data.item_id) !== String(id) || String(data.edition.id) !== String(id)) {
    throw new Error("O registro compartilhado desta edição está inconsistente.");
  }
  return data;
}
function safeBancaReturnUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "uriel29m.github.io" || !/^\/bancadigital\/?$/.test(url.pathname)) return "";
    url.searchParams.delete("ler");
    url.searchParams.delete("edicao");
    url.searchParams.delete("id");
    return url.href;
  } catch { return ""; }
}
async function openBancaEditionLink(value, options = {}) {
  const id = parseBancaEditionId(value);
  const status = $("#banca-link-status");
  if (status) status.textContent = "Buscando edição " + id + "…";
  const [staticResult, overrideResult] = await Promise.allSettled([
    findStaticBancaEdition(id),
    loadCatalogOverride(id)
  ]);
  const baseItem = staticResult.status === "fulfilled" ? staticResult.value : null;
  const overrideRecord = overrideResult.status === "fulfilled" ? overrideResult.value : null;
  if (staticResult.status === "rejected") console.warn("Catálogo estático indisponível:", staticResult.reason);
  if (overrideResult.status === "rejected") console.warn("Metadados atualizados indisponíveis:", overrideResult.reason);
  if (!baseItem && !overrideRecord?.edition) {
    const detail = overrideResult.status === "rejected"
      ? " Não foi possível consultar os metadados atualizados do catálogo."
      : "";
    throw new Error("Não encontrei essa edição no catálogo da Banca Digital. Confira se o ID do link está correto." + detail);
  }
  let item = overrideRecord?.edition
    ? mergeCatalogEdition(baseItem || {id, title: overrideRecord.edition.title || overrideRecord.edition.name || id}, overrideRecord.edition)
    : {...baseItem};
  if (item.catalogDeleted === true) {
    throw new Error("Essa edição foi removida do catálogo da Banca Digital.");
  }
  if (overrideRecord?.edition?.telegramBaseUrl) {
    window.BANCA_SUPABASE_URL = String(overrideRecord.edition.telegramBaseUrl).replace(/\/+$/, "");
  }
  const hasTelegramPages = Array.isArray(item.telegramPages) && item.telegramPages.length > 0;
  const hasTelegramFile = Boolean(item.telegramUrl && item.id && window.BANCA_SUPABASE_URL);
  const staticDirectSource = item.sourceUrl && /\.(pdf|cbz|cbr|jpe?g|png|webp|gif)(?:[?#]|$)/i.test(String(item.sourceUrl));
  const hasSource = Boolean(item.fileUrl || item.url || staticDirectSource || hasTelegramPages || hasTelegramFile);
  if (!hasSource) {
    throw new Error("A edição foi encontrada, mas não tem arquivo nem páginas do Telegram cadastrados para abrir.");
  }
  const directFile = String(item.fileUrl || item.url || (staticDirectSource ? item.sourceUrl : "") || "");
  const normalized = normalizeItem({...item, sourceUrl:directFile, fileUrl:directFile, url:directFile, local:false});
  // A tela inicial permanece atrás do leitor; o botão Voltar retorna ao campo de link.
  state.readerItemId = normalized.id;
  readerIsOpen = false;
  activeReaderCleanup?.();
  activeReaderCleanup = null;
  const readerOptions = {routeSync:true, skipCover: normalized.skipCover === true, standalone:true};
  const returnTo = safeBancaReturnUrl(options.returnTo);
  if (returnTo) readerOptions.returnTo = returnTo;
  openReader(normalized, readerOptions);
}
async function bootStandaloneReader() {
  const fallback = $("#reader-overlay");
  try {
    try { await ensureSupabaseClient(); }
    catch (authError) { console.warn("[ComicReader] Recursos de comunidade indisponíveis:", authError); }
    const linkedEditionId = params.get("ler") || params.get("edicao") || params.get("id");
    if (linkedEditionId) {
      const officialLink = new URL(BANCADIGITAL_BASE);
      officialLink.searchParams.set("ler", linkedEditionId);
      await openBancaEditionLink(officialLink.href, {returnTo: params.get("returnTo")});
      return;
    }
    const edition = await parseEditionPayload();
    if (edition.telegramBaseUrl && !window.BANCA_SUPABASE_URL) {
      window.BANCA_SUPABASE_URL = String(edition.telegramBaseUrl).replace(/\/+$/, "");
    }
    const hasPayload = Boolean(
      edition.sourceUrl || edition.fileUrl || edition.url ||
      (Array.isArray(edition.pages) && edition.pages.length) ||
      (edition.telegramItemId && edition.telegramBaseUrl && Number(edition.pageCount)) ||
      edition.telegramPages
    );
    if (!hasPayload) {
      showEmptyReader();
      $("#reading-mode-select")?.setAttribute("disabled", "");
      return;
    }
    const item = normalizeItem(edition);
    if (Array.isArray(edition.telegramPages) && !item.telegramPages) item.telegramPages = edition.telegramPages;
    if (edition.telegramItemId && !item.telegramPages && Number(edition.pageCount)) {
      item.telegramPages = Array.from({length:Number(edition.pageCount)}, (_, index) => ({page:index + 1}));
      activePageUrls = item.telegramPages.map((_, index) => {
        const u = new URL(String(edition.telegramBaseUrl).replace(/\/+$/, "") + "/functions/v1/telegram-page-image");
        u.searchParams.set("item_id", String(edition.telegramItemId));
        u.searchParams.set("page", String(index + 1));
        return u.href;
      });
      activeEditionForPageUrls = item.id;
    }
    fallback?.remove();
    state.readerItemId = item.id;
    activeReaderCleanup = null;
    readerIsOpen = false;
    openReader(item, {routeSync:true, skipCover: edition.skipCover === true, standalone:true});
  } catch (error) {
    showEmptyReader(error?.message || "Não foi possível carregar a edição.");
  }
}


async function renderTelegramPagesReader(item, body, controls, overlay, skipCover = false, resumePage = 1, onPageChange = () => {}) {
    const pages = Array.isArray(item.telegramPages) ? item.telegramPages : [];
    if (!pages.length || !window.BancaTelegramPages?.imageUrl) throw new Error("Esta edição não possui páginas JPEG válidas no Telegram.");
    const total = pages.length + 1;
    const first = skipCover && pages.length > 1 ? 2 : 1;
    let page = Math.max(first, Math.min(Number(resumePage) || first, total));
    let token = 0;
    const cache = new Map();
    const pending = new Map();
    const load = n => {
      if (n < 1 || n > pages.length) return Promise.resolve(null);
      if (cache.has(n)) return Promise.resolve(cache.get(n));
      if (!pending.has(n)) {
        const promise = (async () => {
          let lastError;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const img = await new Promise((resolve, reject) => {
                const candidate = new Image();
                let settled = false;
                const finish = (fn, value) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  candidate.onload = null;
                  candidate.onerror = null;
                  fn(value);
                };
                const timer = setTimeout(() => {
                  candidate.src = "";
                  finish(reject, new Error("Tempo esgotado ao carregar página " + n));
                }, 5000);
                candidate.decoding = "async";
                candidate.onload = () => finish(resolve, candidate);
                candidate.onerror = () => finish(reject, new Error("Falha ao carregar página " + n));
                candidate.src = window.BancaTelegramPages.imageUrl(item.id, n);
              });
              cache.set(n, img);
              return img;
            } catch (error) { lastError = error; }
          }
          throw lastError || new Error("Falha ao carregar página " + n);
        })();
        pending.set(n, promise);
        promise.then(() => pending.delete(n), () => pending.delete(n));
      }
      return pending.get(n);
    };
    const warm = n => {
      // Prioridade imediata: duas páginas anteriores e duas posteriores.
      for (const next of [n - 2, n - 1, n + 1, n + 2]) {
        if (next >= first && next <= pages.length && !cache.has(next) && !pending.has(next)) {
          void load(next).catch(() => {});
        }
      }
    };
    let backgroundStarted = false;
    const preloadAllInBackground = () => {
      if (backgroundStarted) return;
      backgroundStarted = true;
      // Carrega a edição inteira em segundo plano, sem disparar centenas de pedidos simultâneos.
      const queue = Array.from({ length: pages.length }, (_, i) => i + 1)
        .filter(n => n >= first && n <= pages.length && !cache.has(n))
        .sort((a, b) => Math.abs(a - page) - Math.abs(b - page));
      let cursor = 0;
      const worker = async () => {
        while (cursor < queue.length) {
          const n = queue[cursor++];
          if (cache.has(n)) continue;
          try { await load(n); } catch { /* A navegação pode tentar novamente quando a página for solicitada. */ }
        }
      };
      void Promise.all([worker(), worker()]);
    };
    const drawSingle = async () => {
      const current = ++token;
      const showControls = () => {
        controls.innerHTML = '<button data-prev ' + (page <= first ? "disabled" : "") + '>‹</button><span class="reader-page">' + page + ' / ' + total + '</span><button data-next ' + (page >= total ? "disabled" : "") + '>›</button>';
        $("[data-prev]", controls)?.addEventListener("click", () => {
          if (page > first) { page--; drawSingle(); }
        });
        $("[data-next]", controls)?.addEventListener("click", () => {
          if (page < total) { page++; drawSingle(); }
        });
      };
      showControls();
      onPageChange(item, page, total);
      if (page === total) {
        body.replaceChildren(readerEndPageImage());
        return;
      }
      // Keep the controls live while the image loads; a slow request can't lock navigation.
      body.innerHTML = '<div class="empty" style="margin:auto">Carregando página ' + page + '…</div>';
      try {
        const requestedPage = page;
        const loaded = await load(requestedPage);
        if (current !== token || requestedPage !== page) return;
        const img = document.createElement("img");
        img.className = "reader-image";
        img.alt = "Página " + requestedPage;
        img.decoding = "async";
        img.src = loaded.src;
        body.replaceChildren(img);
        warm(requestedPage);
      } catch {
        if (current !== token || page < 1 || page > pages.length) return;
        body.innerHTML = '<div class="empty" style="margin:auto">Falha ao carregar esta página. <button type="button" data-retry-page>Tentar novamente</button></div>';
        $("[data-retry-page]", body)?.addEventListener("click", () => {
          cache.delete(page);
          pending.delete(page);
          drawSingle();
        }, { once: true });
      }
      if (current !== token) return;
      showControls();
      onPageChange(item, page, total);
    };
    const drawDouble = async () => {
      const current = ++token;
      const start = page === total ? total : Math.max(first, page <= first + 1 ? first : (page % 2 ? page - 1 : page));
      const nums = start === total ? [total] : [start, Math.min(start + 1, pages.length)];
      const spread = document.createElement("div"); spread.className = "reader-double-page";
      try {
        for (const n of nums) {
          const wrapper = document.createElement("div"); wrapper.className = "double-page";
          if (n === total) wrapper.appendChild(readerEndPageImage());
          else { const loaded = await load(n); if (current !== token) return; const img = document.createElement("img"); img.className = "reader-image"; img.alt = "Página " + n; img.src = loaded.src; wrapper.appendChild(img); warm(n); }
          spread.appendChild(wrapper);
        }
      } catch { if (current === token) body.innerHTML = '<div class="empty" style="margin:auto">Não foi possível carregar as páginas do Telegram.</div>'; return; }
      if (current !== token) return;
      body.replaceChildren(spread);
      controls.innerHTML = '<button data-prev ' + (start <= first ? "disabled" : "") + '>‹</button><span class="reader-page">' + nums.join("–") + ' / ' + total + '</span><button data-next ' + (nums[nums.length - 1] >= total ? "disabled" : "") + '>›</button>';
      $("[data-prev]", controls)?.addEventListener("click", () => { if (start > first) { page = Math.max(first, start - 2); draw(); } });
      $("[data-next]", controls)?.addEventListener("click", () => { if (nums[nums.length - 1] < total) { page = Math.min(total, start + 2); draw(); } });
      onPageChange(item, start, total);
    };
    const drawScroll = () => {
      ++token;
      const container = document.createElement("div"); container.className = "image-continuous-scroll-container";
      const els = [];
      for (let n = first; n <= total; n++) {
        const wrapper = document.createElement("div"); wrapper.className = "image-page-wrapper"; wrapper.dataset.pageNum = String(n);
        if (n === total) wrapper.appendChild(readerEndPageImage());
        else { const img = document.createElement("img"); img.className = "reader-image"; img.alt = "Página " + n; img.loading = "lazy"; img.decoding = "async"; img.src = window.BancaTelegramPages.imageUrl(item.id, n); wrapper.appendChild(img); }
        container.appendChild(wrapper); els.push(wrapper);
      }
      body.replaceChildren(container);
      const update = () => {
        const visible = els.find(el => { const rect = el.getBoundingClientRect(); return rect.bottom > 0 && rect.top < window.innerHeight / 2; }) || els[0];
        if (!visible) return;
        page = Number(visible.dataset.pageNum);
        controls.innerHTML = '<button data-prev ' + (page <= first ? "disabled" : "") + '>↑</button><span class="reader-page">' + page + ' / ' + total + '</span><button data-next ' + (page >= total ? "disabled" : "") + '>↓</button>';
        $("[data-prev]", controls)?.addEventListener("click", () => els[Math.max(0, els.indexOf(visible) - 1)]?.scrollIntoView({behavior:"smooth",block:"start"}));
        $("[data-next]", controls)?.addEventListener("click", () => els[Math.min(els.length - 1, els.indexOf(visible) + 1)]?.scrollIntoView({behavior:"smooth",block:"start"}));
        onPageChange(item, page, total);
      };
      container.addEventListener("scroll", update, {passive:true}); update();
      els.find(el => Number(el.dataset.pageNum) === page)?.scrollIntoView({block:"start"});
      overlay._telegramPagesScrollCleanup = () => container.removeEventListener("scroll", update);
    };
    const draw = () => state.readingMode === "continuous-scroll" ? drawScroll() : state.readingMode === "double-page" ? void drawDouble() : void drawSingle();
    preloadAllInBackground();
    const selector = $("#reading-mode-select", overlay);
    if (selector) { selector.disabled = false; selector.addEventListener("change", event => { setReadingMode(event.target.value); draw(); }); }
    draw();
    overlay._telegramPagesCleanup = () => { token++; cache.clear(); pending.clear(); overlay._telegramPagesScrollCleanup?.(); };
    return true;
  }

function openReader(item, options = {}) {
    if (!item) return;
    const telegramPagesMode = !item.local && Array.isArray(item.telegramPages) && item.telegramPages.length > 0;
    if (!canViewCatalogItem(item)) {
      toast("Esta edição está indisponível.");
      return;
    }
    if (!telegramPagesMode && !options.standalone && !options.telegramResolved && !item.local && isTelegramPostUrl(item.telegramUrl) && navigator.onLine !== false && sb && window.BancaTelegram?.published) {
      if (readerIsOpen && activeReaderCleanup && String(state.readerItemId || "") === String(item.id || "") && document.querySelector(".reader-overlay")) return;
      void window.BancaTelegram.published(item, sb).then(canonical => {
        if (!canonical.telegramFileId && !canonical.fileUrl) {
          const published = (window.DEFAULT_LIBRARY || []).find(entry => String(entry.id) === String(item.id));
          if (published && (published.telegramFileId || published.fileUrl)) {
            openReader(mergeCatalogEdition(item, published), { ...options, telegramResolved: true });
            return;
          }
          toast("Esta postagem ainda não foi identificada pelo bot. Um administrador precisa salvar a edição novamente.");
          return;
        }
        openReader(canonical, { ...options, telegramResolved: true });
      }).catch(error => toast(`Não foi possível consultar a fonte do Telegram: ${error.message || error}`));
      return;
    }
    if (!item) return;
    if (readerIsOpen && activeReaderCleanup && String(state.readerItemId || "") === String(item.id || "") && document.querySelector(".reader-overlay")) return;
    if (!canViewCatalogItem(item)) {
      toast("Esta edição está indisponível.");
      return;
    }
    if (!telegramPagesMode && !downloadSource(item) && item?.officialUrl) {
      window.open(item.officialUrl, "_blank", "noopener");
      return;
    }
    const sourceUrl = telegramPagesMode ? window.BancaTelegramPages?.imageUrl(item.id, 1) : downloadSource(item);
    if (isExternalArchiveLink(sourceUrl)) {
      window.open(sourceUrl, "_blank", "noopener");
      return;
    }

    if (!item.local && navigator.onLine === false) {
      activateOfflineMode();
      if (downloaded(item.id)?.status === "completed") return openDownloaded(item);
      toast("Este quadrinho não está disponível offline. Abra a área de Downloads para ver os quadrinhos baixados.");
      setSection("downloads");
      return;
    }

    state.recentlyOpenedIds = [String(item.id), ...state.recentlyOpenedIds.filter(id => String(id) !== String(item.id))].slice(0, 20);
    try { localStorage.setItem("bancaDigitalRecentlyOpened", JSON.stringify(state.recentlyOpenedIds)); } catch {}

    prioritizeReaderLoading();

    if (!item.local && !options.routeSync) {
      navigate({ ler: item.id });
      return;
    }

    activeReaderCleanup?.();
    activeReaderCleanup = null;

    recordComicRead(item);
    const sourceCandidates = telegramPagesMode ? [sourceUrl].filter(Boolean) : readerSourceCandidates(item);
    let resolvedUrl = sourceCandidates[0] || "";

    if (!resolvedUrl) {
      toast(item.telegramUrl ? "Esta edição do Telegram ainda não tem o file_id do bot configurado." : "Esta edição não tem uma URL de arquivo direto.");
      return;
    }

    readerIsOpen = true;
    prioritizeReaderLoading();

    const prefetchedBuffer = isTelegramMediaUrl(resolvedUrl) ? null : readerFilePrefetches.get(resolvedUrl) || null;
    readerFilePrefetches.delete(resolvedUrl);
    const itemFormat = String(item.format || "").toLowerCase();
    const fileFormat = extension(item.file?.name || item.name || "");
    const format = telegramPagesMode ? "telegram-pages" : (/^(pdf|cbz|cbr|jpg|jpeg|png|webp|gif)$/.test(itemFormat)
      ? itemFormat
      : (fileFormat || extension(resolvedUrl)).toLowerCase());
    const skipCover = Object.prototype.hasOwnProperty.call(options, "skipCover") ? options.skipCover === true : shouldSkipCover();
    const savedProgress = progressFor(item);
    const resumePage = savedProgress?.page || (skipCover ? 2 : 1);
    let readerGrayscale = options.grayscale === true;
    const overlay = document.createElement("div");
    overlay.className = "reader-overlay";
    const supportedFormatsForModes = ["pdf", "cbz", "cbr", "telegram-pages"];
    const showModeSelector = supportedFormatsForModes.includes(format);
    overlay.innerHTML = `
      <div class="reader-top">
        <div class="reader-top-primary">
          <button class="small-btn" data-close-reader>← Voltar</button>
          <div class="reader-title">${escapeHTML(itemDisplayTitle(item))}</div>
          <button class="small-btn" data-reader-home>Início</button>
        </div>
        <div class="reader-top-reading">
          ${showModeSelector ? `
            <select class="small-btn" id="reading-mode-select" disabled>
              <option value="single-page" ${state.readingMode === 'single-page' ? 'selected' : ''}>Página por página</option>
              <option value="double-page" ${state.readingMode === 'double-page' ? 'selected' : ''}>
                Duas páginas
              </option>
              <option value="continuous-scroll" ${state.readingMode === 'continuous-scroll' ? 'selected' : ''}>Rolagem contínua</option>
            </select>
          ` : ''}
          <button class="small-btn" id="reading-direction-btn" style="display: ${showModeSelector && state.readingMode === 'double-page' ? 'inline-block' : 'none'};">
            ${state.readingDirection === 'eastern' ? '↔ Oriental' : '↔ Ocidental'}
          </button>
          ${showModeSelector ? `<button class="small-btn" data-toggle-cover>${skipCover ? 'Incluir capa' : 'Ignorar capa'}</button>` : ''}
          <button class="small-btn" data-toggle-grayscale>${readerGrayscale ? 'Cor normal' : 'Preto e branco'}</button>
          <button class="small-btn" data-reader-zoom>Zoom</button>
          ${state.session && !item.local ? `<button class="small-btn" data-toggle-read>${savedProgress?.completed ? 'Desmarcar como lida' : 'Marcar como lida'}</button>` : ''}
        </div>
        <div class="reader-top-actions">
          ${!state.session?.offline ? readerCustomLinksMarkup(item) : ""}
          ${state.profile?.plan === "admin" && !state.session?.offline ? `<button class="small-btn" data-open-external>Ver arquivo</button>` : ''}
        </div>
      </div>
      <div class="reader-body" id="reader-body"></div>
      <div class="reader-bottom-controls">
        <div class="reader-series-controls reader-series-prev" id="reader-series-prev"></div>
        <div class="reader-controls" id="reader-controls"><span class="reader-page">O primeiro carregamento costuma ser demorado.</span></div>
        <div class="reader-series-controls reader-series-next" id="reader-series-next"></div>
      </div>
      <div class="reader-footer">
        ${!item.local && !state.session?.offline && sb ? '<button type="button" class="reader-comments-toggle" data-reader-comments-toggle aria-expanded="false">＋ Comentários</button>' : '<span></span>'}
        <div class="reader-footer-actions">
          ${!state.session?.offline && characterNames(item)[0] ? `<button class="small-btn" data-browse-character="${escapeHTML(characterNames(item)[0])}">Ver personagem</button>` : ''}
          ${!state.session?.offline && item.publisher ? `<button class="small-btn" data-browse-publisher>Ver editora</button>` : ''}
          ${!item.local ? `<button class="small-btn reader-like-button ${state.comicLikeIds.has(item.id) ? "is-liked" : ""}" data-like-item="${escapeHTML(item.id)}">${state.comicLikeIds.has(item.id) ? "♥" : "♡"} ${state.comicLikeCounts.get(item.id) || 0}</button><button class="small-btn" data-share-item="${escapeHTML(item.id)}">Compartilhar</button>` : ""}
          ${item.seriesId ? `<button class="small-btn" data-view-series="${escapeHTML(item.seriesId)}">Série</button>` : ""}
          ${isAdminProfile() && !item.local && !state.session?.offline ? '<button class="small-btn" type="button" data-reader-edit>Editar</button>' : ''}
        </div>
        <div class="reader-comments" data-reader-comments-panel hidden></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const closeReaderButton = $("[data-close-reader]", overlay);
    const readerHomeButton = $("[data-reader-home]", overlay);
    let readerExitToHome = false;
    let removeReaderSwipeListeners = () => {};
    let readerSingleClickTimer = null;
    let readerAdControllerPromise = Promise.resolve(null);
    const cleanupReader = () => {
      if (activeReaderCleanup === cleanupReader) activeReaderCleanup = null;
      readerIsOpen = false;
      if (readerSingleClickTimer) window.clearTimeout(readerSingleClickTimer);
      readerSingleClickTimer = null;
      overlay._pdfDownloadController?.abort();
      overlay._cbzDownloadController?.abort();
      overlay._cbrDownloadController?.abort();
      overlay.remove();
      resumeCoverLoading();
      if (options.localObjectUrl) URL.revokeObjectURL(options.localObjectUrl);
      removeReaderSwipeListeners();
      void readerAdControllerPromise.then(controller => controller?.destroy()).catch(() => {});
    };
    activeReaderCleanup = cleanupReader;
    // Preserve the temporary Blob URL when the reader is re-opened for a
    // layout change. This is essential for files opened from offline storage.
    overlay._reopenReader = (nextOptions = {}) => {
      const localObjectUrl = options.localObjectUrl;
      options.localObjectUrl = null;
      activeReaderCleanup?.();
      openReader(item, {
        ...nextOptions,
        localObjectUrl,
        routeSync: true,
        grayscale: readerGrayscale
      });
    };
    closeReaderButton.onclick = () => {
      cleanupReader();
      const returnTo = safeBancaReturnUrl(options.returnTo);
      if (returnTo) {
        window.location.assign(returnTo);
        return;
      }
      if (readerExitToHome) {
        readerExitToHome = false;
        // "Início" sempre retorna à Banca, mesmo se o leitor foi aberto em uma
        // aba independente ou se a navegação interna ficou inconsistente.
        window.location.assign(BANCADIGITAL_BASE);
        return;
      }
      if (options.standalone) {
        // O leitor independente não deve depender do histórico da aba:
        // links diretos, erros de carregamento e abas abertas sem origem
        // precisam sempre ter uma saída funcional para a Banca Digital.
        window.location.assign(BANCADIGITAL_BASE);
        return;
      }
      if (item.local) {
        showEmptyReader("Arquivo fechado. Escolha outro arquivo do computador ou cole um link da Banca Digital.");
        return;
      }
      // A rota do leitor já foi adicionada ao histórico ao abrir o gibi.
      // Voltar de fato uma entrada evita que o botão Voltar gere um novo
      // histórico e depois reabra o leitor ao ser pressionado novamente.
      if (currentRouteHistoryIndex() > 0) window.history.back();
      else navigate({ pagina: state.session?.offline ? "downloads" : "" }, true);
    };
    readerHomeButton.onclick = () => {
      readerExitToHome = true;
      closeReaderButton.click();
    };
    $("[data-like-item]", overlay)?.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void toggleComicLike(item.id); });
    void refreshComicEngagement(item, overlay);
    $("[data-share-item]", overlay)?.addEventListener("click", event => { event.stopPropagation(); shareComic(item.id); });
    $("[data-comment-item]", overlay)?.addEventListener("click", event => { event.stopPropagation(); openCommentsPopup(item); });
    $("[data-view-series]", overlay)?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const editions = seriesEditions(item);
      // Keep the current reader mounted under the series dialog. The selected
      // edition resolver will replace it only after the new source is resolved.
      void openSeriesSelection(item, editions, false, false, item);
    });
    $$('[data-reader-custom-link]', overlay).forEach(button => button.addEventListener("click", () => window.open(button.dataset.readerCustomLink, "_blank", "noopener")));
    $("[data-open-external]", overlay)?.addEventListener("click", () => window.open(resolvedUrl, "_blank", "noopener"));
    $("[data-reader-edit]", overlay)?.addEventListener("click", event => {
      event.stopPropagation();
      openEditForm(item.id);
    });
    $("[data-toggle-cover]", overlay)?.addEventListener("click", () => {
      const nextSkipCover = !skipCover;
      if (state.session?.user?.id) saveSkipCoverPreference(nextSkipCover);
      const localObjectUrl = options.localObjectUrl;
      options.localObjectUrl = null;
      cleanupReader();
      openReader(item, { skipCover: nextSkipCover, localObjectUrl, routeSync: true, grayscale: readerGrayscale });
    });

    $("[data-toggle-grayscale]", overlay)?.addEventListener("click", event => {
      readerGrayscale = !readerGrayscale;
      body.classList.toggle("reader-grayscale", readerGrayscale);
      event.currentTarget.textContent = readerGrayscale ? "Cor normal" : "Preto e branco";
    });
    $$('[data-browse-character]', overlay).forEach(button => button.addEventListener("click", () => { overlay.remove(); openEntityPage("character", button.dataset.browseCharacter); }));
    $("[data-browse-publisher]", overlay)?.addEventListener("click", () => { overlay.remove(); openEntityPage("publisher", item.publisher); });

    const body = $("#reader-body", overlay);
    const controls = $("#reader-controls", overlay);
    if (!item.local && !state.session?.offline && sb) {
      readerAdControllerPromise = loadReaderAdsFeature()
        .then(feature => feature.createReaderController(item, body))
        .catch(error => { console.warn("Propagandas do leitor indisponíveis:", error); return null; });
    }
    body.addEventListener("contextmenu", async event => {
      const image = event.target.closest("img.reader-image");
      if (!image) return;

      // Administradores baixam a página real. Usuários comuns continuam
      // recebendo a imagem de proteção ao tentar salvar pelo menu de contexto.
      if (state.profile?.plan === "admin") {
        event.preventDefault();
        try {
          const source = image.currentSrc || image.src;
          if (!source) throw new Error("A página não possui uma URL de imagem.");

          const pageCounter = document.querySelector("#reader-controls .reader-page")?.textContent || "";
          const label = String(image.alt || pageCounter);
          const pageMatch = label.match(/(?:página|page)\s*(\d+)/i) || label.match(/^\s*(\d+)/);
          const pageLabel = pageMatch ? String(pageMatch[1]).padStart(3, "0") : String(Date.now());
          const safeName = name => name.replace(/[^a-z0-9._-]/gi, "-");
          const saveUrl = (href, fileName, revoke = false) => {
            const link = document.createElement("a");
            link.href = href;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            if (revoke) window.setTimeout(() => URL.revokeObjectURL(href), 30000);
          };

          const parsedSource = new URL(source, document.baseURI);
          const isTelegramPageEndpoint = /\/functions\/v1\/telegram-page-image\/?$/.test(parsedSource.pathname);
          if (isTelegramPageEndpoint) {
            const isCover = parsedSource.searchParams.get("cover") === "1";
            const fileName = isCover ? "capa.jpg" : "pagina-" + pageLabel + ".jpg";
            // Preservar cover=1 para que a função reconheça downloads da capa.
            parsedSource.searchParams.set("download", "1");
            saveUrl(parsedSource.href, safeName(fileName));
            readerActionToast("Download da página solicitado: " + fileName);
            return;
          }

          const fileNameBase = "pagina-" + pageLabel;
          if (/^(blob:|data:)/i.test(source)) {
            saveUrl(source, fileNameBase + "." + (extension(source) || "jpg"));
            readerActionToast("Download da página solicitado.");
            return;
          }

          try {
            const response = await fetch(source, { cache: "no-store", credentials: "omit", mode: "cors" });
            if (!response.ok) throw new Error("HTTP " + response.status);
            const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
            if (!contentType.startsWith("image/")) throw new Error("A origem não retornou uma imagem (" + (contentType || "tipo desconhecido") + ").");
            const imageBlob = await response.blob();
            if (!imageBlob.size) throw new Error("A imagem baixada está vazia.");
            const extensions = {
              "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
              "image/gif": "gif", "image/avif": "avif"
            };
            const ext = extensions[contentType] || extension(source) || "jpg";
            const downloadUrl = URL.createObjectURL(new Blob([imageBlob], { type: contentType }));
            saveUrl(downloadUrl, fileNameBase + "." + ext, true);
            readerActionToast("Download da página solicitado.");
          } catch (fetchError) {
            const link = document.createElement("a");
            link.href = source;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.click();
            readerActionToast("A origem bloqueou o download automático. A imagem real foi aberta para salvar manualmente.");
            console.warn("[ComicReader] Fetch direto bloqueado; aberta a imagem original:", fetchError);
          }
        } catch (error) {
          console.warn("[ComicReader] Não foi possível baixar a página real:", error);
          readerActionToast("Falha ao baixar a página real: " + (error?.message || String(error)));
        }
        return;
      }

      // Membros comuns usam o menu de contexto nativo do navegador na imagem.
      // Não chamar preventDefault() aqui; isso mantém opções como “Salvar imagem como...”.
      return;
    });
    body.classList.toggle("reader-page-swipe", ["single-page", "double-page"].includes(state.readingMode));
    const toggleReadButton = $("[data-toggle-read]", overlay);
    let readerContentReady = false;
    let readStatusReady = !toggleReadButton;
    const updateReadButtonAvailability = () => {
      if (!toggleReadButton?.isConnected) return;
      toggleReadButton.disabled = !readerContentReady || !readStatusReady || toggleReadButton.dataset.savingRead === "true";
    };
    if (toggleReadButton) {
      toggleReadButton.disabled = true;
      void loadReaderReadStatus(item, toggleReadButton)
        .catch(error => {
          console.warn("[ComicReader] Não foi possível carregar o status de leitura:", error);
          // Saving remains available once the edition is ready; clicking will
          // retry the status query and report a real database error if needed.
        })
        .finally(() => {
          readStatusReady = true;
          updateReadButtonAvailability();
        });
    }
    const readerHasRenderedPage = () => {
      if (!body?.isConnected) return false;
      const canvas = body.querySelector("canvas");
      if (canvas && canvas.width > 0 && canvas.height > 0) return true;
      return Array.from(body.querySelectorAll("img")).some(image =>
        image.complete && image.naturalWidth > 0 && !image.closest(".reader-loading")
      );
    };
    let readReadyObserver = null;
    let readReadyTimer = null;
    const stopReadReadyWatch = () => {
      readReadyObserver?.disconnect();
      readReadyObserver = null;
      if (readReadyTimer !== null) {
        window.clearInterval(readReadyTimer);
        readReadyTimer = null;
      }
    };
    const markReaderReady = () => {
      if (readerContentReady || !readerHasRenderedPage()) return;
      readerContentReady = true;
      stopReadReadyWatch();
      updateReadButtonAvailability();
    };
    // Some renderers append an image whose bytes are already cached; its load
    // event can fire before it enters the DOM. Watch DOM changes and recheck
    // readiness so the button unlocks only after a real page is rendered.
    body.addEventListener("load", event => {
      const image = event.target;
      if (image?.tagName === "IMG" && image.complete && image.naturalWidth > 0) markReaderReady();
    }, true);
    if (toggleReadButton && "MutationObserver" in window) {
      readReadyObserver = new MutationObserver(() => markReaderReady());
      readReadyObserver.observe(body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "width", "height", "class"]
      });
    }
    if (toggleReadButton) {
      // Fallback for renderers that update pixels without a DOM mutation/event.
      readReadyTimer = window.setInterval(() => {
        if (!overlay.isConnected) {
          stopReadReadyWatch();
          return;
        }
        markReaderReady();
      }, 250);
      markReaderReady();
    }
    toggleReadButton?.addEventListener("click", async event => {
      const button = event.currentTarget;
      if (!readerContentReady || !readStatusReady || button.dataset.savingRead === "true") return;
      button.dataset.savingRead = "true";
      updateReadButtonAvailability();
      try {
        const completed = await toggleReadingCompleted(item, progressFor(item)?.total_pages || 1);
        if (completed !== null && button.isConnected) {
          button.textContent = completed ? "Desmarcar como lida" : "Marcar como lida";
        }
      } catch (error) {
        console.error("[ComicReader] Não foi possível salvar o status de leitura:", error);
        readerActionToast("Não foi possível salvar o status de leitura. Tente novamente.");
        try { await loadReaderReadStatus(item, button); } catch (refreshError) {
          console.warn("[ComicReader] Não foi possível atualizar o status de leitura:", refreshError);
        }
      } finally {
        delete button.dataset.savingRead;
        updateReadButtonAvailability();
      }
    });
    overlay._readerNavigate = direction => {
      const button = direction > 0 ? $("[data-next]", controls) : $("[data-prev]", controls);
      if (button && !button.disabled) button.click();
    };
    const toggleReaderChrome = () => overlay.classList.toggle("reader-immersive");
    const readerZoomButton = $("[data-reader-zoom]", overlay);
    let readerZoom = 1;
    const READER_DEFAULT_ZOOM = 1;
    const READER_BUTTON_ZOOM = 2;
    let readerZoomOrigin = { x: "50%", y: "50%" };
    let readerPan = { x: 0, y: 0 };
    let readerPanPointer = null;
    let lastReaderZoomAt = 0;
    const setReaderZoom = (nextZoom, origin = readerZoomOrigin) => {
      readerZoom = Math.max(1, Math.min(3, nextZoom));
      readerZoomOrigin = origin;
      if (readerZoom === READER_DEFAULT_ZOOM) readerPan = { x: 0, y: 0 };
      body.style.setProperty("--reader-zoom", String(readerZoom));
      body.style.setProperty("--reader-pan-x", `${readerPan.x}px`);
      body.style.setProperty("--reader-pan-y", `${readerPan.y}px`);
      body.style.setProperty("--reader-origin-x", origin.x);
      body.style.setProperty("--reader-origin-y", origin.y);
      body.classList.toggle("reader-gesture-zoom", readerZoom > 1);
      readerZoomButton.textContent = readerZoom > 1 ? `Zoom ${Math.round(readerZoom * 100)}%` : "Zoom";
    };
    const toggleReaderZoom = (origin = readerZoomOrigin) => {
      lastReaderZoomAt = Date.now();
      lastReaderClickAt = 0;
      if (readerSingleClickTimer) {
        window.clearTimeout(readerSingleClickTimer);
        readerSingleClickTimer = null;
      }
      setReaderZoom(readerZoom >= READER_BUTTON_ZOOM ? READER_DEFAULT_ZOOM : READER_BUTTON_ZOOM, origin);
      overlay.classList.add("reader-immersive");
    };
    readerZoomButton.onclick = () => toggleReaderZoom();
    let readerSwipe = null;
    let suppressReaderClick = false;
    let lastReaderClickAt = 0;
    let ignoreReaderClicksUntil = 0;
    const activeReaderPointers = new Map();
    let readerPinchStart = null;
    let lastReaderTap = 0;
    let readerTap = null;
    const readerZoomOriginAt = (clientX, clientY) => {
      const rect = body.getBoundingClientRect();
      return { x: `${Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100))}%`, y: `${Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100))}%` };
    };
    const readerPointerDistance = () => {
      const points = [...activeReaderPointers.values()];
      return points.length < 2 ? 0 : Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    };
    const readerPointerCenter = () => {
      const points = [...activeReaderPointers.values()];
      return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    };
    const onReaderPointerDown = event => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (event.target.closest("button, a, select, textarea, input")) return;
      activeReaderPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      body.setPointerCapture?.(event.pointerId);
      if (activeReaderPointers.size === 2) {
        readerPanPointer = null;
        readerSwipe = null;
        readerTap = null;
        readerPinchStart = { distance: readerPointerDistance(), zoom: readerZoom };
        ignoreReaderClicksUntil = Date.now() + 600;
        body.classList.add("reader-panning");
        event.preventDefault();
        return;
      }
      if (readerZoom > 1) {
        readerPanPointer = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: readerPan.x, startY: readerPan.y };
        body.setPointerCapture?.(event.pointerId);
        body.classList.add("reader-panning");
        event.preventDefault();
        return;
      }
      readerTap = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      if (!["single-page", "double-page"].includes(state.readingMode)) return;
      readerSwipe = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onReaderPointerMove = event => {
      if (activeReaderPointers.has(event.pointerId)) activeReaderPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (readerPinchStart && activeReaderPointers.size >= 2) {
        const distance = readerPointerDistance();
        const center = readerPointerCenter();
        const rect = body.getBoundingClientRect();
        if (distance > 0 && rect.width && rect.height) {
          setReaderZoom(readerPinchStart.zoom * distance / readerPinchStart.distance, {
            x: `${((center.x - rect.left) / rect.width) * 100}%`,
            y: `${((center.y - rect.top) / rect.height) * 100}%`
          });
          event.preventDefault();
        }
        return;
      }
      if (readerPanPointer && event.pointerId === readerPanPointer.pointerId) {
        readerPan = {
          x: readerPanPointer.startX + event.clientX - readerPanPointer.x,
          y: readerPanPointer.startY + event.clientY - readerPanPointer.y
        };
        body.style.setProperty("--reader-pan-x", `${readerPan.x}px`);
        body.style.setProperty("--reader-pan-y", `${readerPan.y}px`);
        body.classList.add("reader-panning");
        event.preventDefault();
        return;
      }
      if (!readerSwipe || event.pointerId !== readerSwipe.pointerId) return;
      const dx = event.clientX - readerSwipe.x;
      const dy = event.clientY - readerSwipe.y;
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dx) > Math.abs(dy)) {
        event.preventDefault();
        body.setPointerCapture?.(event.pointerId);
      }
    };
    const finishReaderSwipeAt = (clientX, clientY) => {
      if (!readerSwipe) return;
      const swipe = readerSwipe;
      readerSwipe = null;
      const distance = clientX - swipe.x;
      const verticalDistance = Math.abs(clientY - swipe.y);
      if (Math.abs(distance) < 45 || Math.abs(distance) <= verticalDistance) return;
      suppressReaderClick = true;
      window.setTimeout(() => { suppressReaderClick = false; }, 500);
      overlay._readerNavigate?.(distance < 0 ? 1 : -1);
    };
    const finishReaderSwipe = event => {
      activeReaderPointers.delete(event.pointerId);
      if (readerPanPointer && event.pointerId === readerPanPointer.pointerId) {
        readerPanPointer = null;
        body.classList.remove("reader-panning");
        body.releasePointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }
      if (readerPinchStart) {
        if (activeReaderPointers.size < 2) {
          readerPinchStart = null;
          ignoreReaderClicksUntil = Date.now() + 600;
          body.classList.remove("reader-panning");
        }
        body.releasePointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }
      const tap = readerTap;
      readerTap = null;
      if (tap && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 20) {
        const now = Date.now();
        if (now - lastReaderTap < 320) {
          suppressReaderClick = true;
          toggleReaderZoom(readerZoomOriginAt(event.clientX, event.clientY));
          lastReaderTap = 0;
        } else {
          lastReaderTap = now;
        }
        readerSwipe = null;
        return;
      }
      if (!readerSwipe || event.pointerId !== readerSwipe.pointerId) return;
      event.preventDefault();
      body.releasePointerCapture?.(event.pointerId);
      const now = Date.now();
      if (event.pointerType !== "mouse" && now - lastReaderTap < 320) {
        readerSwipe = null;
        suppressReaderClick = true;
        toggleReaderZoom(readerZoomOriginAt(event.clientX, event.clientY));
        lastReaderTap = 0;
        return;
      }
      lastReaderTap = now;
      finishReaderSwipeAt(event.clientX, event.clientY);
    };
    const onReaderTouchStart = event => {
      if (!["single-page", "double-page"].includes(state.readingMode) || event.touches.length !== 1) return;
      if (readerZoom > 1) return;
      if (event.target.closest("button, a, select, textarea, input")) return;
      const touch = event.touches[0];
      readerSwipe = { pointerId: null, x: touch.clientX, y: touch.clientY };
    };
    const onReaderTouchMove = event => {
      if (readerZoom > 1 && readerPanPointer && event.touches.length === 1) {
        const touch = event.touches[0];
        readerPan = {
          x: readerPanPointer.startX + touch.clientX - readerPanPointer.x,
          y: readerPanPointer.startY + touch.clientY - readerPanPointer.y
        };
        body.style.setProperty("--reader-pan-x", `${readerPan.x}px`);
        body.style.setProperty("--reader-pan-y", `${readerPan.y}px`);
        event.preventDefault();
        return;
      }
      if (!readerSwipe || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - readerSwipe.x;
      const dy = touch.clientY - readerSwipe.y;
      if (Math.abs(dx) > Math.abs(dy)) event.preventDefault();
    };
    const onReaderTouchEnd = event => {
      if (!readerSwipe) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      event.preventDefault();
      finishReaderSwipeAt(touch.clientX, touch.clientY);
    };
    const onReaderMouseDown = event => {
      if (event.button !== 0 || !["single-page", "double-page"].includes(state.readingMode)) return;
      if (readerZoom > 1) return;
      if (event.target.closest("button, a, select, textarea, input")) return;
      readerSwipe = { pointerId: null, x: event.clientX, y: event.clientY };
    };
    const onReaderMouseMove = event => {
      if (readerZoom > 1 && readerPanPointer) {
        readerPan = {
          x: readerPanPointer.startX + event.clientX - readerPanPointer.x,
          y: readerPanPointer.startY + event.clientY - readerPanPointer.y
        };
        body.style.setProperty("--reader-pan-x", `${readerPan.x}px`);
        body.style.setProperty("--reader-pan-y", `${readerPan.y}px`);
        event.preventDefault();
        return;
      }
      if (!readerSwipe) return;
      const dx = event.clientX - readerSwipe.x;
      const dy = event.clientY - readerSwipe.y;
      if (Math.abs(dx) > Math.abs(dy)) event.preventDefault();
    };
    const onReaderMouseUp = event => {
      if (!readerSwipe) return;
      event.preventDefault();
      finishReaderSwipeAt(event.clientX, event.clientY);
    };
    const cancelReaderSwipe = () => { readerSwipe = null; readerTap = null; readerPanPointer = null; body.classList.remove("reader-panning"); activeReaderPointers.clear(); readerPinchStart = null; };
    const preventReaderDrag = event => event.preventDefault();
    body.addEventListener("pointerdown", onReaderPointerDown);
    body.addEventListener("pointermove", onReaderPointerMove, { passive: false });
    body.addEventListener("pointerup", finishReaderSwipe);
    body.addEventListener("pointercancel", cancelReaderSwipe);
    body.addEventListener("dragstart", preventReaderDrag);
    body.addEventListener("touchstart", onReaderTouchStart, { passive: true });
    body.addEventListener("touchmove", onReaderTouchMove, { passive: false });
    body.addEventListener("touchend", onReaderTouchEnd, { passive: false });
    body.addEventListener("mousedown", onReaderMouseDown);
    document.addEventListener("mousemove", onReaderMouseMove, { passive: false });
    document.addEventListener("mouseup", onReaderMouseUp, { passive: false });
    removeReaderSwipeListeners = () => {
      body.removeEventListener("pointerdown", onReaderPointerDown);
      body.removeEventListener("pointermove", onReaderPointerMove);
      body.removeEventListener("pointerup", finishReaderSwipe);
      body.removeEventListener("pointercancel", cancelReaderSwipe);
      body.removeEventListener("dragstart", preventReaderDrag);
      body.removeEventListener("touchstart", onReaderTouchStart);
      body.removeEventListener("touchmove", onReaderTouchMove);
      body.removeEventListener("touchend", onReaderTouchEnd);
      body.removeEventListener("mousedown", onReaderMouseDown);
      document.removeEventListener("mousemove", onReaderMouseMove);
      document.removeEventListener("mouseup", onReaderMouseUp);
    };
    body.addEventListener("click", event => {
      const now = Date.now();
      if (now < ignoreReaderClicksUntil) {
        lastReaderClickAt = 0;
        return;
      }
      const isDoubleReaderClick = event.detail >= 2 || (now - lastReaderClickAt > 0 && now - lastReaderClickAt < 360);
      if (isDoubleReaderClick) {
        if (readerSingleClickTimer) {
          window.clearTimeout(readerSingleClickTimer);
          readerSingleClickTimer = null;
        }
        lastReaderClickAt = 0;
        if (suppressReaderClick) {
          suppressReaderClick = false;
          return;
        }
        toggleReaderZoom(readerZoomOriginAt(event.clientX, event.clientY));
        return;
      }
      lastReaderClickAt = now;
      if (suppressReaderClick) {
        suppressReaderClick = false;
        return;
      }
      if (event.target.closest("button, a, select, textarea")) {
        return;
      }
      if (readerSingleClickTimer) {
        window.clearTimeout(readerSingleClickTimer);
        readerSingleClickTimer = null;
        return;
      }
      readerSingleClickTimer = window.setTimeout(() => {
        readerSingleClickTimer = null;
        toggleReaderChrome();
      }, 280);
    });
    const onReaderKeydown = event => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
      const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      if (!direction) return;
      event.preventDefault();
      overlay._readerNavigate?.(direction);
    };
    document.addEventListener("keydown", onReaderKeydown);
    $("[data-close-reader]", overlay).addEventListener("click", () => document.removeEventListener("keydown", onReaderKeydown), { once: true });
    attachComments(item, overlay);
    body.classList.toggle("reader-grayscale", readerGrayscale);
    const seriesObserver = new MutationObserver(() => appendSeriesNavigation(item, controls, overlay));
    overlay._seriesObserver = seriesObserver;
    seriesObserver.observe(controls, { childList: true });
    appendSeriesNavigation(item, controls, overlay);
    $("[data-close-reader]", overlay).addEventListener("click", () => seriesObserver.disconnect(), { once: true });

    const directionButton = $("#reading-direction-btn", overlay);
    if (directionButton) {
      directionButton.onclick = () => {
        const newDirection = state.readingDirection === "western" ? "eastern" : "western";
        setReadingDirection(newDirection);
        directionButton.textContent = newDirection === "eastern" ? "↔ Oriental" : "↔ Ocidental";

        // If in double-page mode, re-render to apply the change
        if (state.readingMode === "double-page") {
          overlay._reopenReader?.({ skipCover });
        }
      };
    }


    const startReader = async () => {
      body.innerHTML = readerLoadingMarkup("Abrindo edição…");
      const isImage = ["jpg", "jpeg", "png", "webp", "gif"].includes(format) || format === "telegram-pages";
      let selectedIndex = 0;
      if (!item.local && sourceCandidates.length && !isImage) {
        selectedIndex = -1;
        for (let index = 0; index < sourceCandidates.length; index += 1) {
          if (await probeReaderSource(sourceCandidates[index])) { selectedIndex = index; break; }
          if (index === 0) {
            const fallback = sourceCandidates[1] || "nenhuma fonte reserva cadastrada";
            await reportFileFailure(item, `A fonte principal falhou ao abrir. O leitor tentou uma fonte reserva: ${fallback}`, { silent: true, automatic: true, failedUrl: sourceCandidates[0], fallbackUrl: sourceCandidates[1] });
          }
        }
        if (selectedIndex < 0) {
          body.innerHTML = `<div class="empty" style="margin:auto;max-width:650px"><h3>Arquivo indisponível</h3><p>A fonte não entregou o arquivo ao leitor. Verifique o link da edição ou relate o problema aos moderadores.</p><button class="btn btn-primary" data-report-file>Relatar arquivo</button></div>`;
          controls.innerHTML = `<span class="reader-page">${escapeHTML(format.toUpperCase())}</span>`;
          $(`[data-report-file]`, body).onclick = () => reportFileFailure(item, "O arquivo não foi encontrado na fonte cadastrada.");
          return;
        }
        resolvedUrl = sourceCandidates[selectedIndex] || resolvedUrl;
      }
      const selectedFormat = telegramPagesMode ? "telegram-pages" : (item.local ? format : String(item.format || format).toLowerCase());
      if (["pdf", "cbz", "cbr"].includes(selectedFormat)) await ensureReaderDependency(selectedFormat);
      const callback = (...args) => {
        saveReadingProgress(...args);
        // Renderers may report page selection before the image/canvas is ready.
        // Only unlock the read-status action when the first page is actually rendered.
        if (readerHasRenderedPage()) markReaderReady();
        const page = Number(args[1]) || 0;
        const total = Number(args[2]) || 0;
        void readerAdControllerPromise.then(controller => controller?.onPageChange(page, total)).catch(() => {});
      };
      if (selectedFormat === "telegram-pages") {
        await renderTelegramPagesReader(item, body, controls, overlay, skipCover, resumePage, callback);
      } else if (selectedFormat === "pdf" || resolvedUrl.toLowerCase().split("?")[0].endsWith(".pdf")) {
        await renderPDFReader(item, resolvedUrl, body, controls, overlay, skipCover, resumePage, callback, selectedIndex === 0 ? prefetchedBuffer : null);
      } else if (selectedFormat === "cbz" || resolvedUrl.toLowerCase().split("?")[0].endsWith(".cbz")) {
        await renderCBZReader(item, resolvedUrl, body, controls, overlay, skipCover, resumePage, callback, selectedIndex === 0 ? prefetchedBuffer : null);
      } else if (selectedFormat === "cbr" || resolvedUrl.toLowerCase().split("?")[0].endsWith(".cbr")) {
        await renderCBRReader(item, resolvedUrl, body, controls, overlay, skipCover, resumePage, callback, selectedIndex === 0 ? prefetchedBuffer : null);
      }
    };
    if (format === "pdf" || format === "cbz" || format === "cbr" || format === "telegram-pages") {
      void startReader().then(() => {
        if (readerHasRenderedPage()) markReaderReady();
      }).catch(error => {
        console.warn("[ComicReader] A edição não terminou de carregar:", error);
      });
    } else if (["jpg","jpeg","png","webp","gif"].includes(format)) {
      body.innerHTML = readerLoadingMarkup("Abrindo imagem…");
      const image = document.createElement("img");
      image.className = "reader-image";
      image.alt = "";
      image.style.display = "none";
      body.appendChild(image);
      const readerImage = $(".reader-image", body);
      if (readerImage) {
        readerImage.loading = "eager";
        readerImage.fetchPriority = "high";
        readerImage.addEventListener("load", () => {
          body.querySelector(".reader-loading")?.remove();
          readerImage.style.removeProperty("display");
          markReaderReady();
        }, { once: true });
        readerImage.addEventListener("error", async () => {
          if (sourceCandidates.length && readerImage.dataset.backupTried !== "true") {
            readerImage.dataset.backupTried = "true";
            const fallback = sourceCandidates[1] || "nenhuma fonte reserva cadastrada";
            await reportFileFailure(item, `A fonte principal da imagem falhou ao abrir. O leitor tentou uma fonte reserva: ${fallback}`, { silent: true, automatic: true, failedUrl: sourceCandidates[0], fallbackUrl: sourceCandidates[1] });
            if (sourceCandidates[1]) { readerImage.src = sourceCandidates[1]; return; }
          }
          body.innerHTML = `<div class="empty" style="margin:auto;max-width:650px"><h3>Não foi possível abrir esta imagem.</h3><p>O arquivo não abriu. Relate o problema aos moderadores do site para que ele seja verificado.</p><button class="btn btn-primary" data-report-file>Relatar arquivo</button></div>`;
          controls.innerHTML = `<span class="reader-page">Imagem</span>`;
          $("[data-report-file]", body).onclick = () => reportFileFailure(item, "A imagem não abriu no leitor.");
        }, { once: true });
        readerImage.src = resolvedUrl;
      }
      controls.innerHTML = `<span class="reader-page">Imagem</span>`;
      saveReadingProgress(item, 1, 1);
      void readerAdControllerPromise.then(controller => controller?.onPageChange(1, 1)).catch(() => {});
    } else if (item.seriesUrl && !item.fileUrl && !item.telegramUrl) {
      body.innerHTML = `
        <div class="empty" style="margin:auto;max-width:650px">
          <h3>Catálogo externo</h3>
          <p>Esta entrada possui metadados, mas ainda não possui o link individual do arquivo.</p>
          <button class="btn btn-primary" data-open-series>Abrir página da série</button>
        </div>`;
      $(`[data-open-series]`, body).onclick = () => window.open(item.seriesUrl, "_blank", "noopener");
      controls.innerHTML = `<span class="reader-page">LINK EXTERNO</span>`;
    } else {
      const title = "Formato não suportado no leitor";
      const message = `O formato "${escapeHTML(format.toUpperCase())}" não pôde ser aberto pelo leitor. Relate o problema aos moderadores do site para que o arquivo seja verificado.`;
      body.innerHTML = `
        <div class="empty" style="margin:auto;max-width:650px">
          <h3>${escapeHTML(title)}</h3>
          <p>${escapeHTML(message)}</p><button class="btn btn-primary" data-report-file>Relatar arquivo</button>
        </div>`;
      controls.innerHTML = `<span class="reader-page">${escapeHTML(format.toUpperCase())}</span>`;
      $("[data-report-file]", body).onclick = () => reportFileFailure(item, message);
    }
  }

bootStandaloneReader();
