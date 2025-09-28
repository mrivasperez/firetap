import type { FC } from "react";
import "./App.css";
import Count from "./components/Count";

const App: FC = () => {
  return (
    <div id="app-root">
      <main>
        <Count />
      </main>
    </div>
  );
};

export default App;
