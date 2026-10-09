# Font attribution

These WOFF files are **JetBrains Mono**, patched with **Nerd Fonts 3.4.0**
symbols and subsetted. The font's internal family name is `JetBrainsMono NFM`;
the files are renamed `WeaveNerdMono` for this project.

## JetBrains Mono

- Copyright 2020 The JetBrains Mono Project Authors
  (<https://github.com/JetBrains/JetBrainsMono>)
- License: **SIL Open Font License 1.1** — full text in [OFL.txt](./OFL.txt)
- Modified by this project (Nerd Fonts patch + glyph subset). JetBrains Mono
  declares no Reserved Font Name, so renaming does not withdraw the OFL grant.
  The font and its derivatives remain under OFL 1.1 (condition 5).

## Nerd Fonts symbols

- Project: <https://github.com/ryanoasis/nerd-fonts> (patcher and glyph sets,
  version 3.4.0 as recorded in the fonts' version strings)
- The added glyphs come from the symbol sets distributed with Nerd Fonts
  (among them Font Awesome Free, Material Design Icons, Octicons, Codicons,
  Weather Icons, Devicons, Powerline symbols, and others). Each set keeps its
  own license — MIT, Apache 2.0, SIL OFL, or CC BY 4.0. The authoritative
  per-set list is in the upstream repository:
  <https://github.com/ryanoasis/nerd-fonts#included-glyph-sets>
- Sets under CC BY 4.0 are attributed by this notice.

## Use in weave

The fonts are loaded by the dashboard (see `web/src/index.css`) purely for
display. They are not sold by themselves — they ship inside `@weavecode/server`
as part of the dashboard bundle, which satisfies OFL condition 1.
