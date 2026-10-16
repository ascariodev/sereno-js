import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import type { Client } from '@ascariodev/sereno-core';
import { capture } from './global.js';
import { getClient } from './index.js';

export interface FallbackProps {
  error: unknown;
  /** Clears the error and renders the children again. */
  reset: () => void;
}

export interface SerenoErrorBoundaryProps {
  children?: ReactNode;
  /** Rendered instead of the children after an error; a node or a function of the error and `reset`. Defaults to nothing. */
  fallback?: ReactNode | ((props: FallbackProps) => ReactNode);
  /** Called after the error is sent; what it throws is ignored. */
  onError?: (error: unknown, info: ErrorInfo) => void;
  /** Client to send to; defaults to the active one (`getClient()`) at the moment of the error. */
  client?: Client;
}

interface SerenoErrorBoundaryState {
  failed: boolean;
  error: unknown;
}

/** Catches render errors of its children, sends them with React's `componentStack` and renders `fallback`. */
export class SerenoErrorBoundary extends Component<SerenoErrorBoundaryProps, SerenoErrorBoundaryState> {
  override state: SerenoErrorBoundaryState = { failed: false, error: null };

  static getDerivedStateFromError(error: unknown): SerenoErrorBoundaryState {
    return { failed: true, error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    try {
      const client = this.props.client ?? getClient();

      if (client) {
        const componentStack = info?.componentStack;
        capture(client, error, typeof componentStack === 'string' && componentStack !== '' ? { componentStack } : {});
      }
    } catch {
      // reporting must never break the boundary
    }

    try {
      this.props.onError?.(error, info);
    } catch {
      // a failing callback must not break the boundary
    }
  }

  reset = (): void => {
    this.setState({ failed: false, error: null });
  };

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }

    const { fallback } = this.props;

    return typeof fallback === 'function' ? fallback({ error: this.state.error, reset: this.reset }) : (fallback ?? null);
  }
}
