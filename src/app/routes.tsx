import { Navigate, type RouteObject } from "react-router-dom";
import { EditorPage } from "@features/editor/EditorPage";
import { ProjectListPage } from "@features/projects/ProjectListPage";

export const routes: RouteObject[] = [
  { path: "/", element: <ProjectListPage /> },
  { path: "/project/:id", element: <EditorPage /> },
  { path: "*", element: <Navigate to="/" replace /> },
];
