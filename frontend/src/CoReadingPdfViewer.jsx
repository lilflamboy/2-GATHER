import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { auth } from "./firebase.js";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

export async function getPdfPageCountFromArrayBuffer(arrayBuffer) {
  // pdf.js may transfer ownership of the provided buffer to its worker, so
  // read from a clone and keep the caller's buffer intact for uploads.
  const safeBuffer = arrayBuffer instanceof ArrayBuffer ? arrayBuffer.slice(0) : arrayBuffer;
  const loadingTask = pdfjs.getDocument({ data: safeBuffer });
  const pdfDocument = await loadingTask.promise;
  try {
    return Math.max(1, Math.floor(Number(pdfDocument.numPages) || 1));
  } finally {
    await pdfDocument.destroy();
  }
}

export default function CoReadingPdfViewer({
  fileUrl,
  page,
  onDocumentLoadSuccess,
  onDocumentLoadError,
  requiresAuth = false,
}) {
  const shellRef = useRef(null);
  const onDocumentLoadErrorRef = useRef(onDocumentLoadError);
  const [pageWidth, setPageWidth] = useState(760);
  const [isRenderingPage, setIsRenderingPage] = useState(true);
  const [resolvedFileUrl, setResolvedFileUrl] = useState("");
  const [isPreparingDocument, setIsPreparingDocument] = useState(false);

  useEffect(() => {
    onDocumentLoadErrorRef.current = onDocumentLoadError;
  }, [onDocumentLoadError]);

  useEffect(() => {
    if (!shellRef.current || typeof ResizeObserver !== "function") return undefined;

    const updateWidth = () => {
      const nextWidth = Math.max(280, Math.min(860, Math.floor(shellRef.current.clientWidth - 40)));
      setPageWidth(nextWidth);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(shellRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setIsRenderingPage(true);
  }, [fileUrl, page]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    if (!fileUrl) {
      setResolvedFileUrl("");
      setIsPreparingDocument(false);
      return undefined;
    }

    if (!requiresAuth) {
      setResolvedFileUrl(fileUrl);
      setIsPreparingDocument(false);
      return undefined;
    }

    setResolvedFileUrl("");
    setIsPreparingDocument(true);

    (async () => {
      try {
        const token = await auth.currentUser?.getIdToken();
        if (!token) {
          throw new Error("Authentication required to open the shared PDF");
        }
        const response = await fetch(fileUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        if (!response.ok) {
          throw new Error("Could not download the shared PDF");
        }
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResolvedFileUrl(objectUrl);
      } catch (error) {
        if (cancelled) return;
        setResolvedFileUrl("");
        setIsRenderingPage(false);
        onDocumentLoadErrorRef.current?.(error);
      } finally {
        if (!cancelled) {
          setIsPreparingDocument(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [fileUrl, requiresAuth]);

  return (
    <div ref={shellRef} className="relative h-full w-full overflow-auto bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.08),_transparent_48%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_100%)]">
      {(isPreparingDocument || isRenderingPage) && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-white/70 backdrop-blur-[1px]">
          <div className="flex items-center gap-3 rounded-full border border-zinc-200 bg-white px-4 py-2 text-xs text-zinc-600 shadow-lg">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-amber-400" />
            {isPreparingDocument ? "Loading shared PDF" : `Rendering page ${page}`}
          </div>
        </div>
      )}
      <div className="mx-auto flex min-h-full w-full max-w-[920px] items-start justify-center px-4 py-6 sm:px-6 sm:py-8">
        {resolvedFileUrl && (
          <Document
            key={resolvedFileUrl}
            file={resolvedFileUrl}
            loading={null}
            error={null}
            onLoadSuccess={({ numPages }) => {
              onDocumentLoadSuccess?.(Math.max(1, Math.floor(Number(numPages) || 1)));
            }}
            onLoadError={(error) => {
              setIsRenderingPage(false);
              onDocumentLoadError?.(error);
            }}
            className="rounded-[28px] border border-zinc-200/90 bg-white p-3 shadow-[0_24px_60px_rgba(15,23,42,0.10)] sm:p-4"
          >
            <Page
              key={`${resolvedFileUrl}-${page}-${pageWidth}`}
              pageNumber={page}
              width={pageWidth}
              renderAnnotationLayer
              renderTextLayer
              onRenderSuccess={() => setIsRenderingPage(false)}
              onRenderError={(error) => {
                setIsRenderingPage(false);
                onDocumentLoadError?.(error);
              }}
              loading={null}
              className="overflow-hidden rounded-[20px]"
            />
          </Document>
        )}
      </div>
    </div>
  );
}
