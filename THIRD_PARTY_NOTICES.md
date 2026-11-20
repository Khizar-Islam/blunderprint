# Third-party notices

Blunderprint's own code is licensed under the GNU Affero General Public License, version 3 or later ([LICENSE](LICENSE)). It also contains, ships or is built from other people's work. This file lists each one with its licence, where that licence was read, and the notice it asks to be kept.

The licences were checked on 19 November 2026.

| Work | How Blunderprint uses it | Licence |
|---|---|---|
| [Stockfish](https://github.com/official-stockfish/Stockfish), through [stockfish.js](https://github.com/nmrugg/stockfish.js) 19.0.1 | The engine files are served to the browser, unmodified | GPL-3.0 |
| [lila](https://github.com/lichess-org/lila) (Lichess) | Parts of the move classification are a TypeScript port | AGPL-3.0-or-later |
| [scalachess](https://github.com/lichess-org/scalachess) (Lichess) | The win-chance formula and the game-phase divider are TypeScript ports | MIT |
| Chess pieces by Colin M.L. Burnett | Drawn on every board (they come inside react-chessboard) | BSD 3-Clause (one of the author's options) |
| [react-chessboard](https://github.com/Clariity/react-chessboard) 5.12.1 | The board component | MIT |
| [chess.js](https://github.com/jhlywa/chess.js) 1.4.0 | Chess rules, in the browser and on the server | BSD-2-Clause |
| Newsreader, Geist, Geist Mono | The site's fonts, served from the site's own domain | SIL OFL 1.1 |
| [Lichess chess-openings](https://github.com/lichess-org/chess-openings) and the [Lichess game database](https://database.lichess.org/) | Planned data (opening names, position statistics); not in the app yet | CC0-1.0 |
| Chess.com and Lichess game data | Players' public games, fetched through each site's public API | No licence to pass on; credited below |
| Other npm packages | Libraries the app is built on | MIT, ISC, BSD, Apache-2.0 and similar (see the end) |

## Stockfish and stockfish.js

- **Licence:** GNU General Public License, version 3 (GPL-3.0).
- **Read from:** `Copying.txt` in [official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish/blob/master/Copying.txt) and in [nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js/blob/master/Copying.txt), and the `license` field (`GPL-3.0`) of the npm package `stockfish` 19.0.1.
- **What is shipped:** `stockfish-19-lite-single.js` and `stockfish-19-lite-single.wasm`, copied unmodified from the npm package when the site is built (`web/scripts/copy-engine.mjs`) and served from `/engine/`. They are not in this repository.
- **Notices kept:** the full licence text is served next to the files as [`/engine/Copying.txt`](https://blunderprint.vercel.app/engine/Copying.txt), and [`/engine/SOURCE.txt`](https://blunderprint.vercel.app/engine/SOURCE.txt) says where the source code of exactly that version is.
- Blunderprint talks to the engine only through UCI text messages to a Web Worker.

## lila (Lichess)

- **Licence:** GNU Affero General Public License, version 3 or any later version. Copyright the lila authors (Thibault Duplessis and contributors).
- **Read from:** the [LICENSE](https://github.com/lichess-org/lila/blob/master/LICENSE) file and the "License" section of the [README](https://github.com/lichess-org/lila#license) ("Lila is licensed under the GNU Affero General Public License 3 or any later version at your choice").
- **What is ported** (rewritten in TypeScript, so a modified version; first ported 31 October 2026):
  - `backend/src/chess/classify.ts`: the judgement thresholds and mate rules from `modules/tree/src/main/Advice.scala`, the start-position eval and the "only when the move wasn't the engine's best" rule from `modules/tree/src/main/Analysis.scala` and `eval.scala`, and the accuracy per move from `modules/analyse/src/main/AccuracyPercent.scala`.
  - `web/src/lib/winPercent.ts`: the start-position eval.
- **Notices kept:** each of those files names its source files, with the commit they were read at. Because of this port, Blunderprint as a whole is under the same licence family (AGPL-3.0-or-later).

## scalachess (Lichess)

- **Licence:** MIT.
- **Read from:** the [LICENSE](https://github.com/lichess-org/scalachess/blob/master/LICENSE) file.
- **What is ported** (rewritten in TypeScript):
  - `backend/src/chess/classify.ts` and `web/src/lib/winPercent.ts`: the win-chance formula (`WinPercent` in `core/src/main/scala/eval.scala`).
  - `backend/src/chess/phase.ts`: the game-phase divider (`core/src/main/scala/Divider.scala`).
- **Notice:**

```text
Copyright (c) 2012-2014 Thibault Duplessis

The MIT license

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished
to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Chess pieces by Colin M.L. Burnett

- **What it is:** the standard piece drawings from Wikimedia Commons ("Cburnett" set). react-chessboard ships them as its default pieces, and Blunderprint draws them on every board. Checked: the piece paths in the installed package (`defaultPieces` in `react-chessboard/dist`) are the Cburnett drawings, and react-chessboard's own source (`src/pieces.tsx`) credits "en:User:Cburnett" and the Commons category below.
- **Licence:** the author released them under the GNU Free Documentation License, the BSD licence and the GNU General Public License (version 2 or later), "you may select the license of your choice"; Wikimedia Commons also lists CC BY-SA 3.0. **Blunderprint uses them under the BSD licence** (3-clause).
- **Sources:** <https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces> and <https://en.wikipedia.org/wiki/User:Cburnett/GFDL_images/Chess>.
- **Notice:**

```text
Copyright (c) Colin M.L. Burnett 

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## react-chessboard

- **Licence:** MIT.
- **Read from:** the `LICENSE` file and the `license` field of the installed npm package (5.12.1); the same file is in the [repository](https://github.com/Clariity/react-chessboard/blob/main/LICENSE).
- **Notice:**

```text
MIT License

Copyright (c) 2022 Ryan Gregory

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## chess.js

- **Licence:** BSD-2-Clause.
- **Read from:** the `LICENSE` file and the `license` field of the installed npm package (1.4.0); the same file is in the [repository](https://github.com/jhlywa/chess.js/blob/master/LICENSE).
- **Notice:**

```text
Copyright (c) 2025, Jeff Hlywa (jhlywa@gmail.com)
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

## Fonts: Newsreader, Geist and Geist Mono

- **Licence:** SIL Open Font License, version 1.1.
- **Read from:** the `OFL.txt` of each family in [google/fonts](https://github.com/google/fonts) (`ofl/newsreader`, `ofl/geist`, `ofl/geistmono`), where `next/font/google` downloads them from at build time. The site then serves the font files from its own domain.
- **Copyright notices:**
  - Copyright 2020 The Newsreader Project Authors (http://github.com/productiontype/Newsreader)
  - Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git)
- **Licence text:**

```text
-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## Lichess chess-openings and the Lichess game database

- **Licence:** CC0 1.0 (public domain dedication). No notice is required; they are credited anyway.
- **Read from:** [`COPYING.txt`](https://github.com/lichess-org/chess-openings/blob/master/COPYING.txt) in lichess-org/chess-openings, and <https://database.lichess.org/> ("released under the Creative Commons CC0 license").
- **Use:** planned (opening names by position, and position statistics built offline from the game database). Neither is in the running app yet.

## Game data from Chess.com and Lichess

- Players' public games are fetched through the [Chess.com Published-Data API](https://www.chess.com/news/view/published-data-api) and the [Lichess API](https://lichess.org/api). Lichess's own move judgements are kept for games that arrive with its computer analysis.
- Blunderprint is not affiliated with Chess.com, Lichess or any player. It does not use either site's board colours, piece sets or sounds.

## Other npm packages

Everything else the app runs on comes from npm and is used unmodified. Each package's licence text is inside the package itself (`node_modules/<name>/LICENSE` after `npm ci`). Read from the `license` field of every installed production package (`npm ls --omit=dev --all`) on 19 November 2026:

- **web:** MIT (Next.js, React, motion and most others), ISC, 0BSD (tslib), BSD-3-Clause (source-map-js), Apache-2.0 (@swc/helpers, sharp, detect-libc, baseline-browser-mapping), CC-BY-4.0 (caniuse-lite, build-time data), and sharp's prebuilt image library (Apache-2.0 and LGPL-3.0-or-later; used by Next.js on the server, not sent to the browser).
- **backend:** MIT (Express, Mongoose, zod and most others), ISC, BSD-2-Clause, BSD-3-Clause (qs), Apache-2.0 (the MongoDB driver, bson, kareem, mongodb-connection-string-url).

All of these allow use inside an AGPL-3.0-or-later project.
