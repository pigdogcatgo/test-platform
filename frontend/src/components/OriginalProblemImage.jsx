import { useEffect, useState } from 'react';
import { API_URL } from '../config';

function OriginalImage({ url, token }) {
  const [source, setSource] = useState(null);
  const [failed, setFailed] = useState(false);
  const authorized = Boolean(token && url.startsWith('/uploads/'));

  useEffect(() => {
    if (!authorized) return;
    const controller = new AbortController();
    let objectUrl;
    fetch(API_URL + '/api' + url, {
      headers: { Authorization: 'Bearer ' + token },
      signal: controller.signal,
    })
      .then(response => {
        if (!response.ok) throw new Error('Image unavailable');
        return response.blob();
      })
      .then(blob => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [authorized, token, url]);

  if (failed || !authorized) {
    return <p className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">Original image unavailable. A text version is available above.</p>;
  }
  if (!source) {
    return <p role="status" className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">Loading image…</p>;
  }

  return (
    <a href={source} target="_blank" rel="noopener noreferrer" aria-label="Open original problem image at full size" className="block w-fit rounded-lg focus-visible:outline focus-visible:outline-offset-2">
      <img
        src={source}
        alt="Original problem statement. A text version is available above."
        referrerPolicy="no-referrer"
        className="mt-3 w-full max-w-[750px] rounded-lg border bg-white object-contain"
        onError={() => setFailed(true)}
      />
    </a>
  );
}

export default function OriginalProblemImage({ url, token }) {
  return <OriginalImage key={url + '|' + (token ?? '')} url={url} token={token} />;
}
