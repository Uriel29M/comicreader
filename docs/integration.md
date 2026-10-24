# Integração com a Banca Digital

O leitor recebe uma edição isolada codificada em Base64URL UTF-8 no parâmetro data. Exemplo de objeto:

    {
      "id": "edition-123",
      "title": "Nome da edição",
      "format": "images",
      "pages": ["https://exemplo.org/page-001.jpg", "https://exemplo.org/page-002.jpg"]
    }

Exemplo de JavaScript:

    const bytes = new TextEncoder().encode(JSON.stringify(edition));
    let binary = "";
    bytes.forEach(byte => binary += String.fromCharCode(byte));
    const data = btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    window.location.assign("https://uriel29m.github.io/comicreader/?data=" + data);

Use somente páginas da edição selecionada; não reutilize uma lista global de URLs. Carregamentos atrasados de outra geração são descartados.

Suporte inicial: páginas remotas, PDF e CBZ. CBR/libarchive, ponte específica para páginas do Telegram e testes com o catálogo real ainda estão pendentes. Não substituir o leitor de produção antes disso.
