import { useState, useEffect, useMemo, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { toast } from "react-hot-toast";
import { URLS } from "../urls";
import ScreenRecorder from "./recording/ScreenRecorder";
import { ScreenRecorderState } from "../types";

const baseStyle = {
  flex: 1,
  width: "80%",
  margin: "0 auto",
  minHeight: "400px",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "20px",
  borderWidth: 2,
  borderRadius: 2,
  borderStyle: "dashed",
  outline: "none",
  transition: "border .24s ease-in-out",
};

const focusedStyle = {
  borderColor: "#2196f3",
};

const acceptStyle = {
  borderColor: "#00e676",
};

const rejectStyle = {
  borderColor: "#ff1744",
};

// TODO: Move to a separate file
function fileToDataURL(file: File) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
}

type FileWithPreview = {
  preview: string;
} & File;

interface Props {
  setReferenceImages: (
    referenceImages: string[],
    inputMode: "image" | "video"
  ) => void;
}

function ImageUpload({ setReferenceImages }: Props) {
  const [files, setFiles] = useState<FileWithPreview[]>([]);
  // TODO: Switch to Zustand
  const [screenRecorderState, setScreenRecorderState] =
    useState<ScreenRecorderState>(ScreenRecorderState.INITIAL);

  const {
    getRootProps,
    getInputProps,
    isFocused,
    isDragAccept,
    isDragReject,
    open,
  } = useDropzone({
      maxFiles: 1,
      maxSize: 1024 * 1024 * 20, // 20 MB
      noClick: true, // Disable automatic click-to-open, we'll use double-click
      accept: {
        // Image formats
        "image/png": [".png"],
        "image/jpeg": [".jpeg"],
        "image/jpg": [".jpg"],
        // Video formats
        "video/quicktime": [".mov"],
        "video/mp4": [".mp4"],
        "video/webm": [".webm"],
      },
      onDrop: (acceptedFiles) => {
        // Set up the preview thumbnail images
        setFiles(
          acceptedFiles.map((file: File) =>
            Object.assign(file, {
              preview: URL.createObjectURL(file),
            })
          ) as FileWithPreview[]
        );

        // Convert images to data URLs and set the prompt images state
        Promise.all(acceptedFiles.map((file) => fileToDataURL(file)))
          .then((dataUrls) => {
            if (dataUrls.length > 0) {
              setReferenceImages(
                dataUrls.map((dataUrl) => dataUrl as string),
                (dataUrls[0] as string).startsWith("data:video")
                  ? "video"
                  : "image"
              );
            }
          })
          .catch((error) => {
            toast.error("Error reading files" + error);
            console.error("Error reading files:", error);
          });
      },
      onDropRejected: (rejectedFiles) => {
        toast.error(rejectedFiles[0].errors[0].message);
      },
    });

  const pasteEvent = useCallback(
    (event: ClipboardEvent) => {
      // Don't handle paste if user is focused on an input/textarea
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const clipboardData = event.clipboardData;
      if (!clipboardData) return;

      const items = clipboardData.items;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const file = items[i].getAsFile();
        if (file && file.type.startsWith("image/")) {
          imageFiles.push(file);
        }
      }

      if (imageFiles.length === 0) return;

      // Only take the first image
      const file = imageFiles[0];

      // Set up preview thumbnail
      setFiles([
        Object.assign(file, {
          preview: URL.createObjectURL(file),
        }) as FileWithPreview,
      ]);

      // Convert image to data URL and set the reference images state
      fileToDataURL(file)
        .then((dataUrl) => {
          setReferenceImages([dataUrl as string], "image");
          toast.success("Screenshot pasted!");
        })
        .catch((error) => {
          toast.error("Error reading pasted image");
          console.error("Error reading pasted image:", error);
        });
    },
    [setReferenceImages]
  );

  useEffect(() => {
    window.addEventListener("paste", pasteEvent);
    return () => {
      window.removeEventListener("paste", pasteEvent);
    };
  }, [pasteEvent]);

  useEffect(() => {
    return () => files.forEach((file) => URL.revokeObjectURL(file.preview));
  }, [files]); // Added files as a dependency

  const style = useMemo(
    () => ({
      ...baseStyle,
      ...(isFocused ? focusedStyle : {}),
      ...(isDragAccept ? acceptStyle : {}),
      ...(isDragReject ? rejectStyle : {}),
    }),
    [isFocused, isDragAccept, isDragReject]
  );

  return (
    <section className="container">
      {screenRecorderState === ScreenRecorderState.INITIAL && (
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
        <div
          {...getRootProps({ style: style as any })}
          onDoubleClick={open}
          tabIndex={0}
          className="cursor-pointer focus:ring-2 focus:ring-primary focus:ring-offset-2 bg-muted/50 dark:bg-secondary border-border text-muted-foreground"
        >
          <input {...getInputProps()} className="file-input" />
          <p className="text-foreground/70 dark:text-foreground/80 text-lg">
            Drag & drop a screenshot here, <br />
            double-click to upload, or paste from clipboard
          </p>
        </div>
      )}
      {screenRecorderState === ScreenRecorderState.INITIAL && (
        <div className="text-center text-sm text-muted-foreground mt-4">
          Upload a screen recording (.mp4, .mov) or record your screen to clone
          a whole app (experimental).{" "}
          <a
            className="underline hover:text-primary"
            href={URLS["intro-to-video"]}
            target="_blank"
          >
            Learn more.
          </a>
        </div>
      )}
      <ScreenRecorder
        screenRecorderState={screenRecorderState}
        setScreenRecorderState={setScreenRecorderState}
        generateCode={setReferenceImages}
      />
    </section>
  );
}

export default ImageUpload;
