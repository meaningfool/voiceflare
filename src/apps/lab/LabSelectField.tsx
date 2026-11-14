import { useId } from "react";

import { Field, FieldLabel } from "@/apps/lab/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/apps/lab/components/ui/select";
import { cn } from "@/apps/lab/lib/utils";

type SelectFieldOption = {
  label: string;
  value: string;
  /** An option shown but not selectable. */
  disabled?: boolean;
};

/** A Lab run setting: a select named by its control name, mirrored by a native select. */
export function LabSelectField({
  className,
  disabled,
  label,
  name,
  onValueChange,
  onValueReselect,
  options,
  placeholder = "Select an option",
  value,
}: {
  className?: string;
  disabled: boolean;
  label: string;
  name: string;
  onValueChange: (value: string) => void;
  onValueReselect?: (value: string) => void;
  options: readonly SelectFieldOption[];
  placeholder?: string;
  value: string | null;
}) {
  const fieldId = useId();

  return (
    <Field className={cn("run-setting-field", className)} data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
      <Select disabled={disabled} onValueChange={onValueChange} value={value ?? ""}>
        <SelectTrigger id={fieldId} className="w-full bg-card" data-lab-run-setting={name}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                disabled={option.disabled === true}
                data-lab-setting-option={option.value}
                onPointerUp={() => {
                  if (value === option.value) onValueReselect?.(option.value);
                }}
                onKeyDown={(event) => {
                  if (value === option.value && (event.key === "Enter" || event.key === " ")) {
                    onValueReselect?.(option.value);
                  }
                }}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <select
        aria-hidden="true"
        className="live-select-native-mirror"
        disabled={disabled}
        name={name}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        tabIndex={-1}
        value={value ?? ""}
      >
        {options.length === 0 ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
