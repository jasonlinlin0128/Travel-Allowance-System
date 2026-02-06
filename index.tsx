import * as React from "react";
import * as ReactDOM from "react-dom/client";
import App from './App';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<App />);

try {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
} catch (error) {
  console.error("Failed to render app:", error);
  rootElement.innerHTML = `<div style="padding: 20px; color: red;"><h1>Application Error</h1><pre>${String(error)}</pre></div>`;
}