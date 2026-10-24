# ComicReader

Independent reader for Banca Digital comics.

## Migration status

This repository is the isolated destination for extracting the reader from `Uriel29M/bancadigital`. The existing production reader remains unchanged until the independent version is implemented and validated.

## Requirements

- Keep every edition isolated so page images can never mix between editions.
- Keep the previous two and next two pages ready for navigation.
- Load remaining pages in the background without blocking next/previous controls.
- Support Telegram-hosted JPEG pages, PDF, CBZ, and CBR.
- Support single-page, double-page, and continuous-scroll modes.
- Do not depend on Railway.

## Current status

Scaffold only. The reader runtime and integration contract still need to be extracted and tested before this can replace production.
