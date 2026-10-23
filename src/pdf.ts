import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Text of each page of a PDF, in page order (index 0 is page 1). A scanned PDF with no text layer gives empty pages. */
export async function extractPdfPages(file: string): Promise<string[]> {
  const data = new Uint8Array(await readFile(file));
  const task = getDocument({ data, useSystemFonts: true, verbosity: 0 });
  const pdf = await task.promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : ''))
          .join('')
          .replace(/[ \t]+/g, ' ')
          .replace(/ ?\n ?/g, '\n')
          .trim(),
      );
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
