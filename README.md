# ComicReader

Leitor independente para quadrinhos, separado do catálogo Banca Digital.

## Recursos implementados
- Interface própria, sem iframe e sem dependência do Railway.
- Páginas remotas JPEG/PNG/WEBP, PDF, CBZ e CBR/RAR.
- Leitura de páginas JPEG servidas pelo endpoint de imagens do Telegram/Supabase.
- Navegação por botões e teclado; modos de rolagem contínua e duas páginas.
- Mantém as duas páginas anteriores e seguintes prioritárias e aquece as demais em segundo plano.
- Descarta carregamentos de gerações antigas para evitar mistura entre edições.

## Parâmetros de entrada
- `?src=URL&format=pdf|cbz|cbr`
- `?pages=BASE64URL_JSON` para uma lista de URLs de páginas.
- `?data=BASE64URL_JSON` para um objeto de edição. Veja `docs/integration.md`.

## Atenção
O leitor independente ainda precisa ser testado com arquivos reais e ligado ao catálogo da Banca Digital. A produção antiga permanece intacta até validar a integração e a publicação do site.
