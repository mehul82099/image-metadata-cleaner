# image-metadata-cleaner

One-click, client-side cleaner that strips metadata and provenance records
(EXIF, XMP, C2PA Content Credentials, Photoshop IRB, comments) from **JPEG,
PNG and WebP** images - without touching a single pixel byte.

Everything runs locally: a static web page (`index.html`) or a small Node CLI
(`cli.js`). No uploads, no accounts, no dependencies, no build step.

## The honest scope - read this first

AI-generated images can carry three different "markers". They are not the
same thing, and this tool only removes the first one:

| Marker | What it is | This tool |
| --- | --- | --- |
| **Metadata / provenance** | EXIF, XMP and C2PA Content Credentials stored in the file container | **Removed, losslessly** |
| **Invisible pixel watermark** | A signal embedded in the pixels themselves. OpenAI states that ChatGPT-generated images include Google DeepMind's **SynthID**, which is *designed to survive metadata removal*, light edits, cropping and screenshots | **Not removed.** There is no public, reliable, quality-preserving way to remove it, and this project does not claim one |
| **Visible watermark** | A logo or text drawn on the image | Not touched (that is an image edit, not a metadata operation) |

So: if you want a ChatGPT-generated image without the *file-level* provenance
records, this does that verifiably and without quality loss. If you want the
invisible SynthID signal gone, nothing in this repo does or claims that - see
"Why not SynthID removal" below.

## What it does, exactly

- **JPEG**: removes APP1 (EXIF and XMP), APP11 (JUMBF boxes - the container
  C2PA uses), APP13 (Photoshop IRB), COM, and any other APPn except APP0
  (JFIF header), APP2 (ICC color profile) and APP14 (Adobe color transform).
  From the SOS marker onward - all entropy-coded pixel data - bytes are
  copied verbatim.
- **PNG**: removes `tEXt`, `zTXt`, `iTXt`, `eXIf`, `caBX` (C2PA), `tIME` and
  other ancillary chunks. Keeps all critical chunks (IHDR, PLTE, IDAT, IEND)
  plus color and geometry records (`iCCP`, `sRGB`, `gAMA`, `cHRM`, `pHYs`,
  `tRNS`, `bKGD`, `sBIT`). IDAT bytes are copied verbatim.
- **WebP**: removes the `EXIF` and `XMP ` RIFF chunks and clears their VP8X
  feature flags. Keeps image chunks (VP8/VP8L/VP8X, ALPH, ANIM/ANMF) and the
  ICCP color profile. Pixel chunk bytes are copied verbatim; the RIFF size is
  recomputed.
- Reports exactly what it removed and what it kept, per file.
- Malformed or truncated files are rejected with a clear error, never
  silently "fixed".

## Use it

**Web page (one click):** open `index.html` in any modern browser - or serve
the repo with any static host (it is GitHub Pages-ready). Drop an image,
read the report, download the cleaned file. The image never leaves your
device.

**CLI:**

```sh
node cli.js input.jpg            # writes input-cleaned.jpg
node cli.js input.png out.png
```

## Tests

```sh
node --test
```

18 tests build every fixture byte-by-byte and assert the guarantees that
matter: the metadata containers are gone, the pixel-carrying bytes are
byte-identical (JPEG scan data, PNG IDAT, WebP VP8L), color profiles survive,
VP8X flags and RIFF size are consistent, cleaning is idempotent, and a
metadata-free file round-trips unchanged. CI runs them on ubuntu-24.04 and
windows-latest against Node 20 and 22.

## How this compares to existing tools

Researched on 2026-11-09:

- **Metadata removers** (e.g. `linkbuilderinfo0-star/c2pa-metadata-remover`,
  `Mudassirdbs/chatgpt-image-watermark-remover`) share the metadata-stripping
  approach, but ship frameworks (Next.js + WebAssembly) with no test
  evidence, and at least one markets C2PA metadata as an "invisible
  watermark" - conflating the two very different signals above. This repo's
  improvements: zero dependencies, byte-level tests that prove pixels are
  preserved, three formats with the format-correct C2PA containers, and a
  strict distinction between metadata and pixel watermarks.
- **Experimental SynthID removers** (`balyakin/synthid-remover`, MIT;
  `dennisvink/desynthid`) attack the pixel watermark with diffusion models or
  VAE round-trips. They need multi-GB model downloads, alter pixels heavily
  (one reports PSNR 20.68 dB on its own example - visible damage), and verify
  removal with a single manual check on a single image. That is the opposite
  of "high image quality", and none of it is free of heavy tooling.

## Why not SynthID removal

Per OpenAI's own system card and help pages (sources below), ChatGPT images
embed SynthID *in the content itself* so it can survive "some transformations
that remove metadata". The SynthID detector is not public, so a removal claim
cannot even be verified reliably. Any tool claiming one-click, high-quality
SynthID removal is making a claim it cannot back. We strip what can be
stripped verifiably - the metadata - and say so.

To check a file's provenance signals yourself, OpenAI points readers to its
public verification tool (linked below).

## Sources

- [ChatGPT Images 2.6 System Card - Image Provenance](https://deploymentsafety.openai.com/chatgpt-images-2-6/image-provenance) (OpenAI, 2026-11-04): C2PA metadata plus SynthID watermarking in ChatGPT, Codex and API images
- [Provenance signals in OpenAI-generated content](https://help.openai.com/en/articles/8912793-provenance-signals-in-openai-generated-content) (OpenAI Help Center): images include Content Credentials *and* SynthID; watermarks "are designed to withstand common changes"; metadata "can be lost through everyday actions"
- [Verify OpenAI-generated content](https://openai.com/research/verify/) (OpenAI's public provenance verification tool)
- [Google DeepMind - SynthID](https://deepmind.google/models/synthid/)
- [C2PA specification](https://c2pa.org/specifications/specifications/2.2/index.html) (JUMBF container used in JPEG APP11 / PNG caBX)
- Existing implementations researched: [balyakin/synthid-remover](https://github.com/balyakin/synthid-remover), [dennisvink/desynthid](https://github.com/dennisvink/desynthid), [linkbuilderinfo0-star/c2pa-metadata-remover](https://github.com/linkbuilderinfo0-star/c2pa-metadata-remover), [Mudassirdbs/chatgpt-image-watermark-remover](https://github.com/Mudassirdbs/chatgpt-image-watermark-remover)

## Limits

- Pixel-level watermarks (SynthID or others) are not removed or detected.
- JPEG APPn segments outside the keep-list are removed wholesale; a rare
  format extension that stores image data in an exotic APPn (e.g. JPEG XT
  HDR in APP11) would lose it. Standard JPEGs from phones, cameras, and AI
  tools do not use those.
- PNG chunk CRCs are preserved, not re-validated; the tool strips containers,
  it is not a full image validator.
- Tested against byte-level fixtures built in `test.js`. Verified against a
  real ChatGPT-generated image only once a sample is available (one was
  requested; pending).

## License

MIT - Copyright (c) 2026 Mehul Jhabak. See [LICENSE](LICENSE).
