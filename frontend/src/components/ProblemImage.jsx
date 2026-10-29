import { useEffect, useRef, useState } from 'react';
import { API_URL } from '../config';

// Remember URLs that failed so we never re-request (avoids remount/Strict Mode retries and ERR_BLOCKED loops)
const failedImageUrls = new Set();

export default function ProblemImage({ url, token }) {
  const [error, setError] = useState(false);
  const [errorStatus, setErrorStatus] = useState(null); // 401, 404, etc.
  const [blobResult, setBlobResult] = useState({ key: null, url: null });
  const requestKey = url + (token ? '|auth' : '');
  const blobUrl = blobResult.key === requestKey ? blobResult.url : null;

  // For /uploads/xxx we load via authenticated API and show as blob URL
  useEffect(() => {
    if (!url || error || failedImageUrls.has(requestKey)) return;
    const isUpload = url.startsWith('/uploads/');
    const pathPart = isUpload ? url.replace(/^\/uploads\/?/, '') : null;
    if (!isUpload || !pathPart || !token) return;
    // Keep path for /api/uploads/db/123 (DB) or /api/uploads/filename.png (disk)
    const apiUrl = API_URL + url.replace(/^\/uploads/, '/api/uploads');
    let revoked = false;
    fetch(apiUrl, { headers: { Authorization: 'Bearer ' + token } })
      .then((res) => {
        if (revoked) return null;
        if (!res.ok) {
          setErrorStatus(res.status);
          throw new Error(res.status);
        }
        return res.blob();
      })
      .then((blob) => {
        if (revoked || !blob) return;
        setBlobResult({ key: requestKey, url: URL.createObjectURL(blob) });
      })
      .catch((err) => {
        if (!revoked) {
          failedImageUrls.add(requestKey);
          setError(true);
          if (err instanceof Error && err.message && /^\d+$/.test(err.message)) setErrorStatus(Number(err.message));
        }
      });
    return () => {
      revoked = true;
    };
  }, [url, token, requestKey, error]);

  // Revoke blob URL when it changes or on unmount
  const blobUrlRef = useRef(null);
  useEffect(() => {
    const prev = blobUrlRef.current;
    blobUrlRef.current = blobUrl;
    if (prev) URL.revokeObjectURL(prev);
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    };
  }, [blobUrl]);

  const directSrc = url.startsWith('http') ? url : API_URL + (url.startsWith('/') ? url : '/' + url);
  const src = blobUrl != null ? blobUrl : (token && url.startsWith('/uploads/') ? undefined : directSrc);
  const alreadyFailed = failedImageUrls.has(requestKey) || failedImageUrls.has(directSrc);

  // /uploads/ but no token: don't hit direct URL (would 401)
  if (url.startsWith('/uploads/') && !token) {
    return (
      <div className="mt-3 py-4 rounded-lg border border-gray-200 bg-gray-50 text-center text-sm text-gray-500">
        Image unavailable
      </div>
    );
  }

  if (error || alreadyFailed) {
    if (!alreadyFailed) failedImageUrls.add(requestKey);
    const statusHint = errorStatus ? ` (${errorStatus})` : '';
    const extraHint = errorStatus === 404 ? ' — file may be missing on server (try re-uploading).' : '';
    return (
      <div className="mt-3 py-4 rounded-lg border border-gray-200 bg-gray-50 text-center text-sm text-gray-500">
        Image unavailable{statusHint}{extraHint}
      </div>
    );
  }

  // Still loading via fetch (authenticated)
  if (token && url.startsWith('/uploads/') && blobUrl == null && !error) {
    return (
      <div className="mt-3 py-4 rounded-lg border border-gray-200 bg-gray-50 text-center text-sm text-gray-400">
        Loading image…
      </div>
    );
  }

  if (!src) return null;

  return (
    <img
      src={src}
      alt="Problem"
      className="mt-3 max-w-full max-h-64 rounded-lg border object-contain bg-gray-50"
      onError={() => {
        failedImageUrls.add(requestKey);
        failedImageUrls.add(directSrc);
        setError(true);
      }}
    />
  );
}

