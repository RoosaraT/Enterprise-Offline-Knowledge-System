import sys
import json
import fitz  # PyMuPDF

def main():
    if len(sys.argv) < 2:
        print("[]")
        return

    pdf_path = sys.argv[1]
    doc = fitz.open(pdf_path)

    pages = []
    for i in range(len(doc)):
        page = doc[i]
        text = page.get_text("text") or ""
        pages.append({"page": i + 1, "text": text})

    print(json.dumps(pages, ensure_ascii=False))

if __name__ == "__main__":
    main()
