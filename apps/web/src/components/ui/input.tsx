"use client";

import { forwardRef, type InputHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  leftElement?: React.ReactNode;
  rightElement?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      hint,
      leftElement,
      rightElement,
      className = "",
      id,
      disabled,
      ...props
    },
    ref
  ) => {
    const inputId = id || `input-${Math.random().toString(36).substr(2, 9)}`;
    
    return (
      <div className="w-full">
        {label && (
          <label 
            htmlFor={inputId} 
            className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
          >
            {label}
          </label>
        )}
        
        <div className={`relative flex items-center ${leftElement ? "pl-0" : ""} ${rightElement ? "pr-0" : ""}`}>
          {leftElement && (
            <div className="absolute left-3 text-[var(--text-tertiary)] pointer-events-none">
              {leftElement}
            </div>
          )}
          
          <input
            ref={ref}
            id={inputId}
            className={`
              w-full h-10 px-3 py-2 text-sm
              bg-[var(--surface)] 
              border border-[var(--border-default)] 
              rounded-lg
              text-[var(--text-primary)]
              placeholder:text-[var(--text-tertiary)]
              transition-all duration-150
              focus:outline-none 
              focus:border-[var(--border-focus)] 
              focus:ring-2 focus:ring-[var(--border-focus)] focus:ring-opacity-20
              disabled:bg-[var(--bg-subtle)] disabled:text-[var(--text-tertiary)] disabled:cursor-not-allowed
              ${leftElement ? "pl-10" : ""}
              ${rightElement ? "pr-10" : ""}
              ${error ? "border-[var(--danger-primary)] focus:border-[var(--danger-primary)] focus:ring-[var(--danger-primary)]" : ""}
              ${className}
            `}
            disabled={disabled}
            {...props}
          />
          
          {rightElement && (
            <div className="absolute right-3 text-[var(--text-tertiary)]">
              {rightElement}
            </div>
          )}
        </div>
        
        {(error || hint) && (
          <p className={`mt-1.5 text-xs ${error ? "text-[var(--danger-primary)]" : "text-[var(--text-tertiary)]"}`}>
            {error || hint}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";

export const TextArea = forwardRef<HTMLTextAreaElement, InputHTMLAttributes<HTMLTextAreaElement> & { 
  label?: string; 
  error?: string; 
  hint?: string;
}>(
  (
    {
      label,
      error,
      hint,
      className = "",
      id,
      disabled,
      rows = 4,
      ...props
    },
    ref
  ) => {
    const textareaId = id || `textarea-${Math.random().toString(36).substr(2, 9)}`;
    
    return (
      <div className="w-full">
        {label && (
          <label 
            htmlFor={textareaId} 
            className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
          >
            {label}
          </label>
        )}
        
        <textarea
          ref={ref}
          id={textareaId}
          rows={rows}
          className={`
            w-full px-3 py-2 text-sm
            bg-[var(--surface)] 
            border border-[var(--border-default)] 
            rounded-lg
            text-[var(--text-primary)]
            placeholder:text-[var(--text-tertiary)]
            transition-all duration-150
            focus:outline-none 
            focus:border-[var(--border-focus)] 
            focus:ring-2 focus:ring-[var(--border-focus)] focus:ring-opacity-20
            disabled:bg-[var(--bg-subtle)] disabled:text-[var(--text-tertiary)] disabled:cursor-not-allowed
            resize-y
            ${error ? "border-[var(--danger-primary)] focus:border-[var(--danger-primary)] focus:ring-[var(--danger-primary)]" : ""}
            ${className}
          `}
          disabled={disabled}
          {...props}
        />
        
        {(error || hint) && (
          <p className={`mt-1.5 text-xs ${error ? "text-[var(--danger-primary)]" : "text-[var(--text-tertiary)]"}`}>
            {error || hint}
          </p>
        )}
      </div>
    );
  }
);

TextArea.displayName = "TextArea";
