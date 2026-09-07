import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

type BoundaryLocation = ReturnType<typeof useLocation>;

type BoundaryProps = {
  location: BoundaryLocation;
  children: ReactNode;
};

type BoundaryState = {
  error: Error | null;
};

class Boundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Unhandled UI error", error, info.componentStack);
  }

  override componentDidUpdate(prevProps: BoundaryProps): void {
    // A route change unmounts whatever crashed; clear the error so the
    // fallback's «К списку проектов» link actually recovers instead of
    // re-rendering the same dead-end screen (React's reset-on-navigate
    // pattern). A still-broken route simply re-crashes into the fallback.
    if (prevProps.location !== this.props.location && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div role="alert" className="error-boundary">
          <h1>Что-то пошло не так</h1>
          <p>Не удалось отобразить приложение из-за непредвиденной ошибки.</p>
          <pre>{this.state.error.message}</pre>
          <button type="button" onClick={() => window.location.reload()}>
            Перезагрузить
          </button>
          <Link to="/">К списку проектов</Link>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Location-aware wrapper: resets the class boundary on navigation. */
export function ErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <Boundary location={location}>{children}</Boundary>;
}
