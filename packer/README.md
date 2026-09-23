# *Papers, Please* Localization Package Builder

This packer generates game-ready localization packs authored with the [*Papers,
Please* localization tool](https://paperspleaseloc.github.io/). It uses Node.js
and Playwright to render localized page elements directly to images.

## Requirements

- Node.js 24 or newer
- The Playwright WebKit browser

## Installation

From inside the `packer` directory:

```bash
npm install
npx playwright install webkit
```

Playwright requires browser binaries that match the installed Playwright
version, so rerun the browser-install command after upgrading Playwright.

## Usage

Export the localization CSV from the localization tool, then run:

```bash
node . --csv <path.to.csv> --url <url.of.loctool> --out <path.to.output.dir>
```

For example on Windows:

```powershell
node . --csv "C:\Users\me\Downloads\en.csv" --url https://paperspleaseloc.github.io --out "C:\Users\me\Desktop\out"
```

To see the built-in help:

```bash
node . --help
```

The packer creates a temporary `__tmp__<csv-name>` directory under the output
directory while building the pack, then writes `<lang>.zip` to the output
directory. The temporary directory is removed after a successful build and left
in place after a failed build for diagnosis.

Interactive terminals show progress bars for data files and images. When stderr
is not attached to a TTY, such as in CI or fully redirected output, progress
falls back to ordinary line-oriented logging.

## Game

Put `<lang>.zip` into the game's `Loc` subdirectory. Restart the game, and it
should appear as a language option in the settings menu.


## Fonts

If characters appear as `*` in the game, update the fonts to include the missing
characters. [Follow the instructions at the top of the fonts
stylesheet](https://paperspleaseloc.github.io/css/fonts.css), then add
`--makeFonts`:

```bash
node . --csv <path.to.csv> --url <url.of.loctool> --out <path.to.output.dir> --makeFonts
```

## Development

Run the linter with:

```bash
npm run lint
```

The project uses JavaScript with JSDoc type information and `checkJs` through
`jsconfig.json`.


## Implementation

The [*Papers, Please* localization tool](https://paperspleaseloc.github.io/)
uses HTML and CSS to lay out WYSIWYG images used by the game ([excruciating
details
here](http://dukope.tumblr.com/post/83177288060/localizing-papers-please-papers-please-was)).
As a pixel-art game, all text uses non-smoothed sharp bitmap fonts.
*Font-smoothing* options work in most browsers but getting the resultant image
is not easy. Chrome has a tab snapshotting API that I was using previously, but
maintaining the extension and getting it to work reliably on Windows and MacOS
was too much trouble. 

The packer launches headless WebKit through Playwright, loads the localization
data, captures the generated assets, post-processes the pixel-art images with
Jimp, and archives the resulting language pack with JSZip.

## Support

This tool and the localization tool are unsupported. The original implementation
was tested briefly on macOS and Windows.

