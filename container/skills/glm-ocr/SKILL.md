---
name: glm-ocr
description: |
  Extract text from images and scanned PDFs using GLM-OCR (local Ollama or cloud API).

  WHEN TO USE:
  - Any image or PDF attachment the user sends that contains text you need to read.
  - When a PDF appears to be scanned (pdf-extract returns empty or garbled text).
  - When the user says "read this", "what does this say", "OCR this", or provides a receipt, document, screenshot, or photo of text.
  - If you cannot directly understand an image, use this tool to extract its text content first.

  HOW TO USE:
  Run the OCR script with the full container path to the file:
    node /workspace/group/.claude/skills/glm-ocr/scripts/ocr.cjs <file_path> [options]

  The file path will typically be in /workspace/group/media/ — pass it exactly as received.

  OPTIONS:
  - --output <path>        Write to a specific file instead of stdout
  - --category <name>      Auto-save to storage/<category>/ with generated filename
  - --title <title>        Document title (used in filename generation)
  - --format obsidian      Output Obsidian-compatible markdown with YAML frontmatter

  CATEGORY ALIASES: clubs, events, school, shopping, tasks, uplynk, work.
  If no category, output goes to storage/temp/.

  WHAT HAPPENS:
  1. The script sends the image/PDF to GLM-OCR (local Ollama at host.docker.internal:11434 first).
  2. If local Ollama is unavailable, it falls back to Zhipu AI cloud API.
  3. Returns the extracted text as markdown.

  COMMON ERRORS:
  - "Connection refused" on port 11434: Ollama is not running on the host. The admin needs to start it (ollama serve).
  - Empty output: the image may have no readable text, or the model failed to detect it. Try the cloud fallback with ZAI_API_KEY set.
  - "Model not found": the glm-ocr model hasn't been pulled. Run: ollama pull glm-ocr:latest
---

# GLM-OCR

Extract text from scanned documents using GLM-OCR via local Ollama or cloud API.

## Modes (auto-detected)

1. **Local Ollama** (preferred) — connects to `host.docker.internal:11434`
2. **Cloud API** — fallback using Zhipu AI API key

## Usage

```bash
node /workspace/group/.claude/skills/glm-ocr/scripts/ocr.cjs <file_path> [options]
```

### Options

| Option | Description |
|--------|-------------|
| `--output <path>` | Write output to file instead of stdout |
| `--category <name>` | Output to storage/<category>/ with auto-generated filename |
| `--title <title>` | Document title (used in filename generation) |
| `--format <type>` | Output format: `raw` (default) or `obsidian` (with frontmatter) |

### Examples

```bash
# Extract text from a photo in the media folder
node /workspace/group/.claude/skills/glm-ocr/scripts/ocr.cjs /workspace/group/media/2026-04-05T12-30-00_photo.jpg

# Extract from PDF with output file
node /workspace/group/.claude/skills/glm-ocr/scripts/ocr.cjs /workspace/group/media/document.pdf --output /workspace/group/extracted.md

# Use cloud API fallback
ZAI_API_KEY=xxx node /workspace/group/.claude/skills/glm-ocr/scripts/ocr.cjs /workspace/group/media/scan.png
```

## Setup

### Local (Ollama)

Ollama runs on the host at port 11434. The container connects via `host.docker.internal:11434`.

Pull the model:
```bash
ollama pull glm-ocr:latest
```

### Cloud Fallback

Set `ZAI_API_KEY` environment variable or add to `~/.nanoclaw/config.json`:
```json
{
  "skills": {
    "entries": {
      "glm-ocr": { "apiKey": "your-key" }
    }
  }
}
```

## Storage Paths

Inside the container:
- Media files: `/workspace/group/media/`
- Output: `/workspace/group/` or specify with `--output`

## Requirements

- **Local:** Ollama with `glm-ocr:latest` model running on host
- **Cloud:** Zhipu AI API key (get at https://docs.z.ai)