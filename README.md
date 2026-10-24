# ComicReader

Leitor independente para quadrinhos, separado do catálogo Banca Digital.

## Implementado na primeira versão
- Interface própria, sem iframe e sem dependência do Railway.
- Páginas JPEG/PNG/WEBP remotas, PDF e CBZ.
- Navegação por botões, teclado e número da página.
- Rolagem contínua e modo de duas páginas.
- Pré-carregamento das duas páginas anteriores e seguintes, com aquecimento do restante em segundo plano.
- Proteção por geração para descartar carregamentos atrasados e evitar mistura de páginas entre edições.

## Abrir uma edição
Aceita `?src=URL&format=pdf`, `?src=URL&format=cbz`, `?pages=BASE64URL_JSON` ou `?data=BASE64URL_JSON`.

## Ainda não pronto para substituir produção
CBR/libarchive, ponte específica para as páginas do Telegram e testes de integração com o catálogo real ainda precisam ser concluídos. O leitor antigo da Banca Digital não foi alterado nesta migração inicial.
