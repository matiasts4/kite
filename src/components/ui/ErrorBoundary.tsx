import { Component, ErrorInfo, ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  name?: string;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      `[ErrorBoundary${this.props.name ? `:${this.props.name}` : ''}] caught error:`,
      error,
      errorInfo
    );
    this.props.onError?.(error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div
          role="alert"
          style={{
            padding: '16px',
            color: 'var(--text-danger, #ef4444)',
            backgroundColor: 'var(--pane, #181818)',
            border: '1px solid var(--panel-stroke, rgba(255, 255, 255, 0.1))',
            borderRadius: '6px',
            margin: '8px',
            fontSize: '12px',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>
            {this.props.name ? `${this.props.name} failed to display` : 'Component failed to display'}
          </div>
          <div style={{ opacity: 0.8, wordBreak: 'break-word', fontFamily: 'monospace', fontSize: '11px' }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </div>
          <button
            type="button"
            style={{
              marginTop: '10px',
              padding: '4px 10px',
              borderRadius: '4px',
              background: 'var(--subtle-fill, rgba(255, 255, 255, 0.08))',
              border: '1px solid var(--panel-stroke, rgba(255, 255, 255, 0.15))',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: '12px',
            }}
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
