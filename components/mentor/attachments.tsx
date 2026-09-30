"use client";
import { useId, useRef, useState } from "react";
import { Download, File as FileIcon, Upload, X } from "lucide-react";
import type { AttachmentDto, ParentKind, UploadFile } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { mentorRequest } from "./api";
import { useMutation } from "./hooks";
import { ErrorNotice } from "./ui";

const MAX_BYTES = 5 * 1024 * 1024;
function fileSize(bytes: number | null) { return bytes === null ? "Size unavailable" : bytes < 1024 ? `${bytes} ${bytes === 1 ? "byte" : "bytes"}` : `${(bytes / 1024).toFixed(0)} KB`; }
const mimeByExtension: Record<string, UploadFile["mimeType"]> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif", pdf: "application/pdf" };
export type AttachmentContext = { parentKind: ParentKind; parentId?: string; groupId?: string; version?: string };
type Props = { context: AttachmentContext; files: AttachmentDto[]; onChange?: (files: AttachmentDto[]) => void; onVersion?: (version: string) => void; onBusy?: (busy: boolean) => void; photoOnly?: boolean; readOnly?: boolean; disabled?: boolean; label?: string };
async function encodeFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("This file couldn’t be read. Please choose it again.")); reader.readAsDataURL(file); });
}
export function Attachments({ context, files, onChange, onVersion, onBusy, photoOnly = false, readOnly = false, disabled = false, label = "Attachments" }: Props) {
  const id = useId(); const input = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<File | null>(null); const [localError, setLocalError] = useState<Error | null>(null); const [downloading, setDownloading] = useState<string | null>(null);
  const mutation = useMutation();
  const parent = { parentKind: context.parentKind, ...(context.parentId ? { parentId: context.parentId } : {}), ...(context.groupId ? { groupId: context.groupId } : {}) };
  async function upload() {
    if (!selected) return;
    setLocalError(null); onBusy?.(true);
    try {
      const extension = selected.name.split(".").at(-1)?.toLowerCase() || "";
      const mime = !selected.type || selected.type === "application/octet-stream" ? mimeByExtension[extension] : selected.type;
      if (!mimeByExtension[extension] || mime !== mimeByExtension[extension] || (photoOnly && mime === "application/pdf")) throw new Error(photoOnly ? "Choose a JPEG, PNG, HEIC or HEIF photo." : "Choose a JPEG, PNG, HEIC, HEIF or PDF file.");
      if (!selected.size || selected.size > MAX_BYTES) throw new Error("Each file must be between 1 byte and 5 MiB.");
      if (files.length >= 5) throw new Error("You can attach up to five files to this record.");
      const result = await mutation.run("attachments.upload", { ...parent, ...(context.version ? { expectedVersion: context.version } : {}), file: { fileName: selected.name, mimeType: mime as UploadFile["mimeType"], contentBase64: await encodeFile(selected) } });
      if (result) { onChange?.([...files, result.attachment]); if (result.parentVersion) onVersion?.(result.parentVersion); setSelected(null); if (input.current) input.current.value = ""; }
    } catch (error) { setLocalError(error as Error); } finally { onBusy?.(false); }
  }
  async function remove(file: AttachmentDto) {
    setLocalError(null); onBusy?.(true);
    const result = await mutation.run("attachments.delete", { ...parent, attachmentId: file.id, ...(context.version ? { expectedVersion: context.version } : {}) });
    if (result) { onChange?.(files.filter(item => item.id !== file.id)); if (result.parentVersion) onVersion?.(result.parentVersion); }
    onBusy?.(false);
  }
  async function download(file: AttachmentDto) {
    setDownloading(file.id); setLocalError(null);
    try { const result = await mentorRequest("attachments.download", { ...parent, attachmentId: file.id }); const url = new URL(result.downloadUrl, window.location.origin); if (url.origin !== window.location.origin) throw new Error("This download link could not be verified."); const anchor = document.createElement("a"); anchor.href = url.href; anchor.download = file.fileName; document.body.appendChild(anchor); anchor.click(); anchor.remove(); }
    catch (error) { setLocalError(error as Error); } finally { setDownloading(null); }
  }
  return <Field><FieldLabel htmlFor={readOnly ? undefined : id}>{label}</FieldLabel>
    {files.length ? <ul className="attachment-list">{files.map(file => <li key={file.id}><FileIcon aria-hidden="true" /><span className="attachment-name"><strong>{file.fileName}</strong><small>{fileSize(file.sizeBytes)}{file.mimeType === "image/heic" || file.mimeType === "image/heif" ? " · Download to view" : ""}</small></span><Button type="button" variant="ghost" size="icon" aria-label={`Download ${file.fileName}`} onClick={() => void download(file)} disabled={downloading === file.id}><Download /></Button>{!readOnly ? <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${file.fileName}`} onClick={() => void remove(file)} disabled={disabled || mutation.pending}><X /></Button> : null}</li>)}</ul> : readOnly ? <p className="muted">No attachments.</p> : null}
    {!readOnly ? <><div className="upload-controls"><Input ref={input} id={id} type="file" accept={photoOnly ? ".jpg,.jpeg,.png,.heic,.heif" : ".jpg,.jpeg,.png,.heic,.heif,.pdf"} onChange={e => { setSelected(e.target.files?.[0] || null); setLocalError(null); }} disabled={disabled || mutation.pending || files.length >= 5} /><Button type="button" variant="outline" onClick={() => void upload()} disabled={!selected || disabled || mutation.pending}><Upload data-icon="inline-start" />{mutation.pending ? "Uploading…" : "Upload file"}</Button></div><FieldDescription>{photoOnly ? "JPEG, PNG, HEIC or HEIF" : "JPEG, PNG, HEIC, HEIF or PDF"}. Up to 5 MiB each, five files maximum. Select a file, then upload it before saving.</FieldDescription></> : null}
    <ErrorNotice error={localError || mutation.error} />
  </Field>;
}
