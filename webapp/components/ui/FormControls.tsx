import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";

import styles from "./form-controls.module.css";

type FormFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "name"> & {
  id: string;
  name: string;
  label: string;
};

export function FormField({ id, name, label, ...inputProps }: FormFieldProps) {
  return (
    <label className={styles.field} htmlFor={id}>
      <span>{label}</span>
      <input id={id} name={name} {...inputProps} />
    </label>
  );
}

export function FormButton({ className = "", ...buttonProps }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`${styles.button} ${className}`.trim()} {...buttonProps} />;
}

export function FormError({ children }: { children: ReactNode }) {
  return <div className={styles.error} role="alert">{children}</div>;
}

export function ReadingSurface({ children, ariaLabel }: { children: ReactNode; ariaLabel: string }) {
  return <section className={styles.readingSurface} aria-label={ariaLabel}>{children}</section>;
}
