# Integração com a Banca Digital

O leitor aceita uma edição por URL. O catálogo deve montar um objeto isolado e codificá-lo em Base64URL UTF-8 no parâmetro data.

Exemplo de objeto JSON:

    {
      "id": "edition-123",
      "title": "Nome da edição",
      "format": "images",
      "pages": ["https://exemplo.org/page-001.jpg", "https://exemplo.org/page-002.jpg"]
    }

Exemplo de integração JavaScript:

    const bytes = new TextEncoder().encode(JSON.stringify(edition));
    let binary = "";
    bytes.forEach(byte => binary += String.fromCharCode(byte));
    const data = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    window.location.assign("https://uriel29m.github.io/comicreader/?data=" + data);

Use somente as páginas da edição selecionada; não reutilize uma lista global de URLs. O leitor invalida operações pendentes ao trocar a edição para impedir que respostas atrasadas apareçam na edição atual.

Estado atual: páginas remotas, PDF e CBZ. A ponte específica para Telegram deve garantir que cada URL seja pública e acessível por CORS. CBR/libarchive e testes com o catálogo real ainda estão pendentes; não substituir o leitor de produção antes disso.