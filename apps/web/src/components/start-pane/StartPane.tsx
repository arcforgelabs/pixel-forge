import React from "react";
import ImageUpload from "../ImageUpload";
import ImportCodeSection from "../ImportCodeSection";
import { Stack } from "../../lib/stacks";

interface Props {
  doCreate: (images: string[], inputMode: "image" | "video") => void;
  importFromCode: (code: string, stack: Stack) => void;
}

const StartPane: React.FC<Props> = ({ doCreate, importFromCode }) => {
  return (
    <div className="flex flex-col justify-center items-center gap-y-10">
      <ImageUpload setReferenceImages={doCreate} />
      <ImportCodeSection importFromCode={importFromCode} />
    </div>
  );
};

export default StartPane;
