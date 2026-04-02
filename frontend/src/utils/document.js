const guessDocumentFileName = (value) => {
  try {
    const parsed = new URL(String(value || ""));
    const segment = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(segment || "").trim() || "shared-document.pdf";
  } catch {
    return "shared-document.pdf";
  }
};

const buildDocumentSignature = (fileName, fileSize) => `${String(fileName || "shared-document.pdf").trim()}:${Math.max(0, Math.floor(Number(fileSize) || 0))}`;

const isSharedUploadUrl = (value) => {
  try {
    const parsed = new URL(String(value || ""));
    return /\/api\/uploads\/document\/[^/]+$/i.test(parsed.pathname || "");
  } catch {
    return false;
  }
};

export { guessDocumentFileName, buildDocumentSignature, isSharedUploadUrl };
