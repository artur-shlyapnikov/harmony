import { Route, Routes } from "react-router-dom";
import { useEffect } from "react";
import { routes } from "./routes";
import { preloadToneModule } from "@audio/AudioEngine";
export function App() {
  // Audio chunk warm-up (§3.17): Tone.js stays out of every module graph and
  // is pre-imported at the first idle frame after boot — while the project
  // list is on screen, so opening a project never pays the parse stall and
  // the first Играть press stays instant. Deep links straight into the
  // editor get the same post-paint placement. Test runs never schedule it
  // (vitest sets MODE=test) so no suite pulls the real audio stack.
  useEffect(() => {
    if (import.meta.env.MODE === "test") return undefined;
    if (typeof requestIdleCallback === "function") {
      const idleId = requestIdleCallback(() => preloadToneModule());
      return () => cancelIdleCallback(idleId);
    }
    const timer = window.setTimeout(preloadToneModule, 1500);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <Routes>
      {routes.map((route) => (
        <Route key={route.path} path={route.path} element={route.element} />
      ))}
    </Routes>
  );
}

