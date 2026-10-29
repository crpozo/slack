import { GENERAL_CHANNEL_ID } from "@mindfultech/shared";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Catches a render error in the main view (a conversation, a board…) so it
 * can't take the whole app down to a blank screen: the sidebar stays, the
 * view says what happened and offers a way out. Opening another view
 * (`resetKey` changes) tries again.
 */
export class ViewBoundary extends Component<
  Readonly<{ resetKey: string; children: ReactNode }>,
  { error: Error | null; key: string }
> {
  override state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(
    props: Readonly<{ resetKey: string }>,
    state: { error: Error | null; key: string },
  ) {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[view] render failed", error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        role="alert"
        data-view-error
      >
        <p className="text-ink">Something went wrong showing this view.</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-surface-hover"
          >
            Try again
          </button>
          <Link to={`/app/${GENERAL_CHANNEL_ID}`} className="btn-primary">
            Go to #general
          </Link>
        </div>
      </div>
    );
  }
}
