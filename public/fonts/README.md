# Bundled fonts

CAKRAWALA serves its web fonts locally so startup and icons never depend on
reaching Google's font servers.

| Family | Source | License |
|---|---|---|
| Inter (300–600) | Google Fonts | SIL Open Font License 1.1 |
| JetBrains Mono (300–700) | Google Fonts | SIL Open Font License 1.1 |
| Material Symbols Outlined (opsz 20, wght 400, FILL 0, GRAD 0) | Google Fonts | Apache License 2.0 |

`fonts.css` holds the stylesheet rules exactly as Google Fonts served them for
the families and axes above, with each `url()` rewritten to a file in this
folder. To refresh, fetch the same Google Fonts CSS URLs with a current Chrome
user agent, download every referenced `.woff2`, and rewrite the `url()`s.
