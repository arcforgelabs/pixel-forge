declare module 'pdfjs-dist/webpack.mjs' {
  export interface PdfViewport {
    width: number
    height: number
  }

  export interface PdfRenderTask {
    promise: Promise<void>
  }

  export interface PdfPageProxy {
    pageNumber: number
    getViewport(params: { scale: number }): PdfViewport
    render(params: {
      canvasContext: CanvasRenderingContext2D
      viewport: PdfViewport
      transform?: number[]
    }): PdfRenderTask
  }

  export interface PdfDocumentProxy {
    numPages: number
    getPage(pageNumber: number): Promise<PdfPageProxy>
    destroy(): Promise<void>
  }

  export interface PdfDocumentLoadingTask {
    promise: Promise<PdfDocumentProxy>
  }

  export function getDocument(src: {
    data: Uint8Array
    useWorkerFetch?: boolean
  }): PdfDocumentLoadingTask
}

declare module 'pdfjs-dist/web/pdf_viewer.mjs' {
  export class TextLayerBuilder {
    div: HTMLDivElement
    constructor(options: {
      pdfPage: unknown
    })
    render(viewport: unknown): Promise<void>
  }
}
