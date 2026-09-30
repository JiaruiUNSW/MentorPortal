"use client";
import { useId } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
export function TextField({ label, value, onChange, multiline = false, required = false, disabled = false, description, maxLength, type = "text", min, max, step }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; required?: boolean; disabled?: boolean; description?: string; maxLength?: number; type?: string; min?: string; max?: string; step?: string }) {
  const id = useId();
  const props = { id, value, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value), required, disabled, maxLength, "aria-describedby": description ? `${id}-description` : undefined };
  return <Field><FieldLabel htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</FieldLabel>{multiline ? <Textarea {...props} rows={4} /> : <Input {...props} type={type} min={min} max={max} step={step} />}{description ? <FieldDescription id={`${id}-description`}>{description}</FieldDescription> : null}</Field>;
}
export function CheckField({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) { const id = useId(); return <Field orientation="horizontal" className="check-field"><Checkbox id={id} checked={checked} onCheckedChange={value => onChange(value === true)} disabled={disabled} /><FieldLabel htmlFor={id}>{label}</FieldLabel></Field>; }
