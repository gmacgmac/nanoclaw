#!/usr/bin/env node
/**
 * GLM-OCR - Extract text from scanned PDFs and images
 * Usage: node ocr.cjs <file_url_or_path> [options]
 *
 * Options:
 *   --output <path>    Write output to file instead of stdout
 *   --category <name>  Output to storage/<category>/ with auto-generated filename
 *   --title <title>    Document title (used in filename generation)
 *   --format <type>    Output format: 'raw' (default) or 'obsidian' (with frontmatter)
 *
 * Supports:
 *   - Local Ollama (auto-detected at host.docker.internal:11434 or localhost:11434)
 *   - Cloud API (Zhipu AI) as fallback
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Config
const OLLAMA_HOSTS = ['host.docker.internal', 'localhost'];
const OLLAMA_PORT = 11434;
const OLLAMA_MODEL = 'glm-ocr:latest';
const CLOUD_API_HOST = 'api.z.ai';
const CLOUD_API_PORT = 443;

// Storage paths - use NANOCLAW_DIR env var or default
const NANOCLAW_ROOT = process.env.NANOCLAW_DIR || path.join(process.env.HOME || '/home/node', '.nanoclaw');
const STORAGE_ROOT = path.join(NANOCLAW_ROOT, 'storage');
const TEMP_DIR = path.join(STORAGE_ROOT, 'temp');

// Category aliases (short names -> paths)
const CATEGORY_ALIASES = {
  'clubs': 'home/kids/school/clubs',
  'events': 'home/kids/school/events',
  'school': 'home/kids/school',
  'shopping': 'home/shopping',
  'tasks': 'home/tasks',
  'uplynk': 'work/uplynk',
  'work': 'work/uplynk',
};

// Parse command line args
function parseArgs(args) {
  const result = {
    input: null,
    output: null,
    category: null,
    title: null,
    format: 'raw'
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--output' && args[i + 1]) {
      result.output = args[++i];
    } else if (arg === '--category' && args[i + 1]) {
      result.category = args[++i];
    } else if (arg === '--title' && args[i + 1]) {
      result.title = args[++i];
    } else if (arg === '--format' && args[i + 1]) {
      result.format = args[++i];
    } else if (!arg.startsWith('--')) {
      result.input = arg;
    }
  }

  return result;
}

// Generate output filename
function generateOutputFilename(inputPath, title, category) {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const baseName = title
    ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    : path.basename(inputPath, path.extname(inputPath)).toLowerCase().replace(/[^a-z0-9]+/g, '-');

  return `${date}-${baseName}-ocr.md`;
}

// Resolve category to full path
function resolveCategoryPath(category) {
  if (!category) return TEMP_DIR;

  // Check if it's an alias
  const resolved = CATEGORY_ALIASES[category.toLowerCase()];
  if (resolved) {
    return path.join(STORAGE_ROOT, resolved);
  }

  // Treat as direct path (relative to storage)
  return path.join(STORAGE_ROOT, category);
}

// Format output as Obsidian markdown
function formatAsObsidian(text, meta) {
  const frontmatter = `---
source: "${meta.source}"
date_processed: "${meta.date}"
category: "${meta.category}"
original_path: "${meta.originalPath}"
---

`;

  const header = `# ${meta.title}

**Source:** ${meta.sourceFilename}
**Date:** ${meta.date}
**Category:** ${meta.category}

---

## Extracted Text

`;

  return frontmatter + header + text + '\n\n---\n\n_Tags: #ocr #${meta.categoryTag}_\n';
}

// Get API key from env var or NanoClaw config
function getApiKey() {
  if (process.env.ZAI_API_KEY) return process.env.ZAI_API_KEY;
  try {
    const configPath = path.join(NANOCLAW_ROOT, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config?.skills?.entries?.['glm-ocr']?.apiKey || config?.skills?.entries?.['glm-ocr.apiKey']?.apiKey;
  } catch (e) { return null; }
}

// Check if Ollama is running
async function checkOllama(host) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: host,
      port: OLLAMA_PORT,
      path: '/api/tags',
      method: 'GET',
      timeout: 2000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            const hasModel = json.models?.some(m => m.name.startsWith('glm-ocr'));
            resolve(hasModel ? host : null);
          } catch { resolve(null); }
        } else { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Find available Ollama instance
async function findOllama() {
  for (const host of OLLAMA_HOSTS) {
    const found = await checkOllama(host);
    if (found) return found;
  }
  return null;
}

// Extract using Ollama
async function extractWithOllama(host, imageData, mimeType) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: 'Extract all text from this document. Output only the extracted text in markdown format.',
      images: [imageData],
      stream: false
    });

    const options = {
      hostname: host,
      port: OLLAMA_PORT,
      path: '/api/generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Ollama error ${res.statusCode}: ${data}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve({ text: json.response || '', raw: json });
        } catch (e) {
          reject(new Error(`Failed to parse Ollama response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Extract using Cloud API
async function extractWithCloud(fileUrl) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('No API key found. Set ZAI_API_KEY or add to ~/.nanoclaw/config.json');
  }

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'glm-ocr',
      file: fileUrl
    });

    const options = {
      hostname: CLOUD_API_HOST,
      port: CLOUD_API_PORT,
      path: '/api/paas/v4/layout_parsing',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Cloud API error ${res.statusCode}: ${data}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          const text = json.md_results || json.pages?.map(p => p.markdown).filter(Boolean).join('\n\n---\n\n') || '';
          resolve({ text, raw: json });
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Main
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) {
    console.error('Usage: node ocr.cjs <file_url_or_path> [options]');
    console.error('');
    console.error('Options:');
    console.error('  --output <path>    Write output to file instead of stdout');
    console.error('  --category <name>  Output to storage/<category>/ with auto-generated filename');
    console.error('  --title <title>    Document title (used in filename generation)');
    console.error('  --format <type>    Output format: "raw" (default) or "obsidian"');
    console.error('');
    console.error('Category aliases:');
    Object.entries(CATEGORY_ALIASES).forEach(([alias, fullPath]) => {
      console.error(`  ${alias.padEnd(12)} -> storage/${fullPath}/`);
    });
    console.error('');
    console.error('Examples:');
    console.error('  node ocr.cjs https://example.com/document.pdf');
    console.error('  node ocr.cjs ./scan.jpg --output ./output.md');
    console.error('  node ocr.cjs ./newsletter.pdf --category school --title "October Newsletter"');
    console.error('  node ocr.cjs ./receipt.png --category shopping --format obsidian');
    process.exit(1);
  }

  const input = args.input;
  let fileUrl = input;
  let localFile = null;
  let mimeType = 'application/octet-stream';

  // Check if input is a local file
  if (!input.startsWith('http://') && !input.startsWith('https://')) {
    const resolvedPath = path.resolve(input);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`Error: File not found: ${resolvedPath}`);
      process.exit(1);
    }
    localFile = resolvedPath;
    const ext = path.extname(resolvedPath).toLowerCase();
    mimeType = ext === '.pdf' ? 'application/pdf'
             : ext === '.png' ? 'image/png'
             : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
             : 'application/octet-stream';
    console.error(`Processing: ${path.basename(resolvedPath)} (${(fs.statSync(resolvedPath).size / 1024).toFixed(1)} KB)`);
  }

  // Determine output path
  let outputPath = args.output;
  let categoryPath = args.category ? resolveCategoryPath(args.category) : TEMP_DIR;

  if (!outputPath && (args.category || args.format === 'obsidian')) {
    // Ensure category directory exists
    if (!fs.existsSync(categoryPath)) {
      fs.mkdirSync(categoryPath, { recursive: true });
    }
    const filename = generateOutputFilename(localFile || input, args.title, args.category);
    outputPath = path.join(categoryPath, filename);
  }

  // Try Ollama first
  const ollamaHost = await findOllama();
  let result;

  if (ollamaHost) {
    console.error(`Using Ollama at ${ollamaHost}:${OLLAMA_PORT}...`);

    let imageData;
    if (localFile) {
      imageData = fs.readFileSync(localFile).toString('base64');
    } else {
      // Download from URL
      console.error('Downloading from URL...');
      const chunks = [];
      await new Promise((resolve, reject) => {
        https.get(input, (res) => {
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', resolve);
          res.on('error', reject);
        });
      });
      imageData = Buffer.concat(chunks).toString('base64');
    }

    try {
      result = await extractWithOllama(ollamaHost, imageData, mimeType);
      console.error('[Extracted via Ollama - Local inference]');
    } catch (err) {
      console.error(`Ollama failed: ${err.message}`);
      console.error('Falling back to cloud API...');
    }
  } else {
    console.error('Ollama not available, using cloud API...');
  }

  // Fallback to cloud if Ollama didn't work
  if (!result) {
    if (localFile) {
      const fileData = fs.readFileSync(localFile);
      const base64 = fileData.toString('base64');
      fileUrl = `data:${mimeType};base64,${base64}`;
    }

    try {
      result = await extractWithCloud(fileUrl);
      console.error('[Extracted via Cloud API]');
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  }

  // Format output
  let outputText = result.text;

  if (args.format === 'obsidian') {
    const meta = {
      source: localFile || input,
      sourceFilename: localFile ? path.basename(localFile) : input,
      date: new Date().toISOString().split('T')[0],
      category: args.category || 'temp',
      categoryTag: (args.category || 'temp').replace(/\//g, '-'),
      originalPath: localFile || input,
      title: args.title || (localFile ? path.basename(localFile, path.extname(localFile)) : 'Document')
    };
    outputText = formatAsObsidian(result.text, meta);
  }

  // Write or print output
  if (outputPath) {
    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, outputText);
    console.error(`Output written to: ${outputPath}`);

    // Print summary to stdout for programmatic use
    console.log(JSON.stringify({
      success: true,
      outputPath: outputPath,
      category: args.category || 'temp',
      charCount: outputText.length
    }));
  } else {
    // Print to stdout
    console.log(outputText);
  }
}

main();