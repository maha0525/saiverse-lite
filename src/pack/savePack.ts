const REVOKE_DELAY_MS = 60_000;

/**
 * Hands the finished ZIP to the person. Runs from a tap: `navigator.share` needs one, which is
 * why saving is a button and not the end of the export. iOS does not save a blob download from
 * an installed PWA reliably, and its share sheet has「ファイルに保存」. Browsers that refuse a
 * ZIP in `canShare` take the download.
 */
export async function savePackFile(file: Blob, fileName: string): Promise<void> {
  const zip = new File([file], fileName, { type: "application/zip" });
  if (navigator.maxTouchPoints > 0 && navigator.canShare?.({ files: [zip] })) {
    try {
      await navigator.share({ files: [zip] });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.warn("[SAIVerse Lite][pack] sharing failed, downloading instead", error);
    }
  }
  const url = URL.createObjectURL(zip);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
