// Text -> .docx (minimal OOXML). Produces a valid Word document containing
// one paragraph per input line, default Calibri 11, US Letter with 1in margins.
// Full Unicode support (XML is UTF-8).

import { zip } from './zip.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// One <w:p> per line; tabs become <w:tab/> runs so indentation survives.
function paragraph(line: string): string {
  const parts = line.split('\t').map((p) => `<w:t xml:space="preserve">${esc(p)}</w:t>`);
  return `<w:p><w:r>${parts.join('<w:tab/>')}</w:r></w:p>`;
}

function buildDocumentXml(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  return (
    XML_DECL +
    `<w:document xmlns:w="${W_NS}"><w:body>` +
    lines.map(paragraph).join('') +
    // US Letter (12240x15840 twips), 1in margins
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
    '</w:sectPr></w:body></w:document>'
  );
}

const STYLES_XML =
  XML_DECL +
  `<w:styles xmlns:w="${W_NS}"><w:docDefaults>` +
  '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  '</w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
  '<w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>';

const CONTENT_TYPES_XML =
  XML_DECL +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '</Types>';

const RELS_XML =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

const DOC_RELS_XML =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

export function buildDocx(text: string): Blob {
  const encoder = new TextEncoder();
  const bytes = zip([
    { name: '[Content_Types].xml', data: encoder.encode(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: encoder.encode(RELS_XML) },
    { name: 'word/document.xml', data: encoder.encode(buildDocumentXml(text)) },
    { name: 'word/styles.xml', data: encoder.encode(STYLES_XML) },
    { name: 'word/_rels/document.xml.rels', data: encoder.encode(DOC_RELS_XML) },
  ]);
  return new Blob([bytes], { type: DOCX_MIME });
}
