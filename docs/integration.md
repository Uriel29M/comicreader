# Integração com a Banca Digital

O leitor recebe uma edição isolada codificada em Base64URL UTF-8 no parâmetro `data`. Para páginas JPEG hospedadas pelo endpoint Telegram/Supabase, use este objeto:

    {
      "id": "edition-123",
      "title": "Nome da edição",
      "format": "images",
      "telegramBaseUrl": "https://SEU-PROJETO.supabase.co",
      "telegramItemId": "edition-123",
      "pageCount": 24
    }

Para páginas remotas comuns, use `pages` como lista ordenada de URLs. Para arquivo único, use `sourceUrl` e `format` (`pdf`, `cbz` ou `cbr`).

Exemplo de codificação:

    const bytes = new TextEncoder().encode(JSON.stringify(edition));
    let binary = "";
    bytes.forEach(byte => binary += String.fromCharCode(byte));
    const data = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    window.location.assign("https://uriel29m.github.io/comicreader/?data=" + data);

Não reutilize listas globais de páginas: cada navegação deve receber um único objeto de edição. A versão de produção da Banca Digital ainda não foi alterada; o link de integração será ligado somente depois dos testes reais.
