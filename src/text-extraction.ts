import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink, mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

interface ExtractionResult {
  text: string;
  totalPages?: number;
  extractedPages?: string;
  method: string;
}

/** Parse a page range string like "1-5" or "1,3,7-9" into an array of 1-based page numbers. */
function parsePageRange(pages: string, totalPages: number): number[] {
  const result = new Set<number>();
  for (const part of pages.split(",")) {
    const trimmed = part.trim();
    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Math.max(1, parseInt(range[1]));
      const end = Math.min(totalPages, parseInt(range[2]));
      for (let i = start; i <= end; i++) result.add(i);
    } else {
      const n = parseInt(trimmed);
      if (n >= 1 && n <= totalPages) result.add(n);
    }
  }
  return [...result].sort((a, b) => a - b);
}

function formatPageRange(pages: number[]): string {
  if (pages.length === 0) return "";
  const ranges: string[] = [];
  let start = pages[0], end = pages[0];
  for (let i = 1; i < pages.length; i++) {
    if (pages[i] === end + 1) {
      end = pages[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = end = pages[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(",");
}

/** Extract text from PDF using pdf-parse (pure JS, primary method). */
async function extractWithPdfParse(data: Buffer, pages?: number[]): Promise<ExtractionResult> {
  const { PDFParse } = await import("pdf-parse");
  const pdf = new PDFParse({ data: new Uint8Array(data) });

  const parseParams: any = {};
  if (pages && pages.length > 0) {
    parseParams.partial = pages;
  }

  const result = await pdf.getText(parseParams);
  const totalPages = result.pages.length || (pages ? Math.max(...pages) : 0);

  // If we used partial, the actual total might be higher — get it from a full parse
  let actualTotal = totalPages;
  if (!pages) {
    actualTotal = result.pages.length;
  } else {
    // Do a quick metadata-only parse to get total page count
    try {
      const info = await pdf.getText({ partial: [1] });
      // The total is embedded in the default page joiner
      actualTotal = Math.max(totalPages, result.pages.length);
    } catch {
      // ignore
    }
  }

  const targetPages = pages || Array.from({ length: actualTotal }, (_, i) => i + 1);

  await pdf.destroy();

  return {
    text: result.text,
    totalPages: actualTotal,
    extractedPages: formatPageRange(targetPages),
    method: "pdf-parse",
  };
}

/** Extract text from PDF using pdftotext (poppler, often better layout). */
async function extractWithPdftotext(data: Buffer, pages?: number[]): Promise<ExtractionResult | null> {
  const tmpPath = join(tmpdir(), `extract-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  try {
    await writeFile(tmpPath, data);

    // Get page count via pdfinfo
    let totalPages = 0;
    try {
      const { stdout } = await execFileAsync("pdfinfo", [tmpPath]);
      const match = stdout.match(/Pages:\s+(\d+)/);
      if (match) totalPages = parseInt(match[1]);
    } catch {
      return null; // poppler not available
    }

    const targetPages = pages || Array.from({ length: totalPages }, (_, i) => i + 1);

    const args = ["-layout"];
    if (pages && pages.length > 0) {
      const first = Math.min(...pages);
      const last = Math.max(...pages);
      if (last - first + 1 === pages.length) {
        args.push("-f", String(first), "-l", String(last));
      }
    }
    args.push(tmpPath, "-");

    const { stdout } = await execFileAsync("pdftotext", args, { maxBuffer: 50 * 1024 * 1024 });

    return {
      text: stdout,
      totalPages,
      extractedPages: formatPageRange(targetPages),
      method: "pdftotext",
    };
  } catch {
    return null;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

/** Extract text from PDF using OCR (pdftoppm + tesseract). */
async function extractWithOcr(data: Buffer, totalPages: number, pages?: number[]): Promise<ExtractionResult | null> {
  const tmpDir = await mkdtemp(join(tmpdir(), "ocr-"));
  const pdfPath = join(tmpDir, "input.pdf");

  try {
    await writeFile(pdfPath, data);
    const targetPages = pages || Array.from({ length: totalPages }, (_, i) => i + 1);

    const pdftoppmArgs = ["-png", "-r", "300"];
    if (pages && pages.length > 0) {
      pdftoppmArgs.push("-f", String(Math.min(...pages)), "-l", String(Math.max(...pages)));
    }
    pdftoppmArgs.push(pdfPath, join(tmpDir, "page"));

    await execFileAsync("pdftoppm", pdftoppmArgs, { maxBuffer: 100 * 1024 * 1024 });

    const files = (await readdir(tmpDir)).filter((f) => f.endsWith(".png")).sort();
    const textParts: string[] = [];

    for (const file of files) {
      const imgPath = join(tmpDir, file);
      try {
        const { stdout } = await execFileAsync("tesseract", [imgPath, "-", "--oem", "1"], {
          maxBuffer: 10 * 1024 * 1024,
        });
        textParts.push(stdout);
      } catch {
        textParts.push(`[OCR failed for ${file}]`);
      }
    }

    if (textParts.length === 0) return null;

    return {
      text: textParts.join("\n\n--- Page Break ---\n\n"),
      totalPages,
      extractedPages: formatPageRange(targetPages),
      method: "ocr",
    };
  } catch {
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Extract text from a DOCX file using adm-zip. */
async function extractDocx(data: Buffer): Promise<ExtractionResult> {
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(data);
  const docXml = zip.readAsText("word/document.xml");

  const text = docXml
    .replace(/<w:p[^>]*>/g, "\n")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, method: "docx" };
}

/** Main extraction function. */
export async function extractText(
  data: Buffer,
  filename: string,
  mimeType: string,
  pages?: string
): Promise<ExtractionResult> {
  const lower = filename.toLowerCase();

  // Plain text types
  if (
    mimeType.startsWith("text/plain") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".csv") ||
    lower.endsWith(".json") ||
    lower.endsWith(".xml") ||
    lower.endsWith(".md")
  ) {
    return { text: data.toString("utf-8"), method: "direct" };
  }

  // HTML
  if (mimeType === "text/html" || lower.endsWith(".html") || lower.endsWith(".htm")) {
    const html = data.toString("utf-8");
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { text, method: "html-strip" };
  }

  // PDF
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) {
    // Try pdftotext first (better layout preservation)
    const pdftotextResult = await extractWithPdftotext(data, pages ? undefined : undefined);
    let totalPages = pdftotextResult?.totalPages || 0;

    const targetPages = pages && totalPages > 0 ? parsePageRange(pages, totalPages) : undefined;

    if (pdftotextResult) {
      // Re-run with page filter if needed
      if (targetPages) {
        const filtered = await extractWithPdftotext(data, targetPages);
        if (filtered && filtered.text.trim().length > 50) return filtered;
      } else if (pdftotextResult.text.trim().length > 50) {
        return pdftotextResult;
      }
    }

    // Try pdf-parse (pure JS)
    try {
      const pdfParseResult = await extractWithPdfParse(data, targetPages);
      totalPages = totalPages || pdfParseResult.totalPages || 0;
      if (pdfParseResult.text.trim().length > 50) {
        return pdfParseResult;
      }
    } catch {
      // pdf-parse failed, continue
    }

    // Try OCR
    if (totalPages > 0) {
      const ocr = await extractWithOcr(data, totalPages, targetPages);
      if (ocr && ocr.text.trim().length > 0) {
        return ocr;
      }
    }

    return {
      text: "Could not extract text from this PDF. It may be a scanned document and OCR tools are not available. Use get_attachment with inline=true to download the raw file.",
      totalPages: totalPages || undefined,
      extractedPages: targetPages ? formatPageRange(targetPages) : totalPages ? `1-${totalPages}` : undefined,
      method: "none",
    };
  }

  // DOCX
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lower.endsWith(".docx")
  ) {
    try {
      return await extractDocx(data);
    } catch (err: any) {
      return { text: `Failed to extract DOCX text: ${err.message}`, method: "error" };
    }
  }

  // Images - try OCR
  if (mimeType.startsWith("image/") || /\.(png|jpe?g|tiff?|bmp|gif|webp)$/i.test(lower)) {
    const tmpPath = join(tmpdir(), `ocr-img-${Date.now()}.${lower.split(".").pop() || "png"}`);
    try {
      await writeFile(tmpPath, data);
      const { stdout } = await execFileAsync("tesseract", [tmpPath, "-", "--oem", "1"], {
        maxBuffer: 10 * 1024 * 1024,
      });
      return { text: stdout, method: "ocr" };
    } catch {
      return {
        text: "OCR tools are not available. Use get_attachment with inline=true to download the raw image.",
        method: "none",
      };
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }

  return {
    text: `Text extraction is not supported for ${mimeType} files. Use get_attachment with inline=true to download the raw file.`,
    method: "unsupported",
  };
}
