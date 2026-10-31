import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../domain";
import { imageEntries, imageLabel } from "../memory/conversation";
import type { AttachmentItem } from "../pack/attachments";

export type ReadImage = (personaId: string, item: AttachmentItem) => Promise<Blob | null>;

function AttachmentImage({ item, read }: { item: Record<string, unknown>; read(item: AttachmentItem): Promise<Blob | null> }) {
  const holder = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Each read takes a file out of the ZIP, so it waits until the row is close to the screen.
  useEffect(() => {
    const element = holder.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNear(true);
        observer.disconnect();
      }
    }, { rootMargin: "400px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let created: string | null = null;
    void read(item).then((blob) => {
      if (cancelled) return;
      if (!blob) {
        setFailed(true);
        return;
      }
      created = URL.createObjectURL(blob);
      setUrl(created);
    }).catch((error: unknown) => {
      console.warn("[SAIVerse Lite][chat] attachment could not be read", { uri: item.uri ?? item.path, error });
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [near, item, read]);

  const summary = typeof item.summary === "string" ? item.summary : "";
  if (failed) return <p className="message-image-missing">{imageLabel(item)}</p>;
  return <div ref={holder} className={url ? "message-image" : "message-image loading"}>{url && <img src={url} alt={summary} />}</div>;
}

/** Every image a row carries. A file the ZIP does not hold shows as the same text the model receives. */
export function MessageImages({ message, onReadImage }: { message: ChatMessage; onReadImage: ReadImage }) {
  const items = useRef(imageEntries(message.metadata)).current;
  const read = useRef((item: AttachmentItem) => onReadImage(message.personaId, item)).current;
  if (items.length === 0) return null;
  return <div className="message-images">{items.map((item) => <AttachmentImage key={String(item.uri ?? item.path)} item={item} read={read} />)}</div>;
}
