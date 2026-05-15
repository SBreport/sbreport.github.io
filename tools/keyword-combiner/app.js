const sourceConfig = {
  branches: {
    textareaId: "branches",
    fileInputId: "branchFile",
    fileNameId: "branchFileName",
    badgeId: "branchBadge",
    heroCountId: "branchCount",
    label: "지점",
  },
  procedures: {
    textareaId: "procedures",
    fileInputId: "procedureFile",
    fileNameId: "procedureFileName",
    badgeId: "procedureBadge",
    heroCountId: "procedureCount",
    label: "시술",
  },
  keywords: {
    textareaId: "keywords",
    fileInputId: "keywordFile",
    fileNameId: "keywordFileName",
    badgeId: "keywordBadge",
    heroCountId: "keywordCount",
    label: "키워드",
  },
};

const previewLimit = 500;

const state = {
  branches: [],
  procedures: [],
  keywords: [],
  results: [],       // 마지막 조합하기 결과 rows
  activeLabels: [],  // 마지막 조합하기 시점의 활성 필드 레이블
  xlsxReady: false,
};

document.addEventListener("DOMContentLoaded", () => {
  state.xlsxReady = Boolean(window.XLSX);
  bindTextareas();
  bindFileInputs();
  bindButtons();
  updateCountsOnly();
  updateSpreadsheetUi();
});

// ===== 활성 소스 / 카테시안 곱 =====

function getActiveSources() {
  return [
    { key: "branches",   values: state.branches,   label: "지점" },
    { key: "procedures", values: state.procedures, label: "시술" },
    { key: "keywords",   values: state.keywords,   label: "키워드" },
  ].filter((s) => s.values.length > 0);
}

function cartesianProduct(arrays) {
  if (arrays.length === 0) {
    return [];
  }
  return arrays.reduce(
    (acc, arr) => acc.flatMap((a) => arr.map((b) => [...a, b])),
    [[]]
  );
}

// ===== 이벤트 바인딩 =====

function bindTextareas() {
  Object.values(sourceConfig).forEach((config) => {
    const textarea = document.getElementById(config.textareaId);
    textarea.addEventListener("input", () => {
      updateStateFromTextarea(config);
      updateCountsOnly();
    });
  });
}

function bindFileInputs() {
  Object.entries(sourceConfig).forEach(([key, config]) => {
    const input = document.getElementById(config.fileInputId);

    input.addEventListener("change", async (event) => {
      const [file] = event.target.files || [];
      if (!file) {
        updateFileName(config, "선택한 파일 없음");
        return;
      }

      updateFileName(config, file.name);

      try {
        const values = await readValuesFromFile(file);
        const textarea = document.getElementById(config.textareaId);
        textarea.value = values.join("\n");
        state[key] = values;
        updateCountsOnly();
        setStatus(`${config.label} 파일에서 ${values.length.toLocaleString("ko-KR")}개를 불러왔어요.`);
      } catch (error) {
        console.error(error);
        setStatus(`${config.label} 파일을 읽는 중 문제가 생겼어요: ${error.message}`, true);
      } finally {
        input.value = "";
      }
    });
  });
}

function bindButtons() {
  document.getElementById("combineButton").addEventListener("click", updateResult);
  document.getElementById("fillSampleButton").addEventListener("click", fillSampleData);
  document.getElementById("clearButton").addEventListener("click", clearAll);
  document.getElementById("downloadXlsxButton").addEventListener("click", downloadXlsx);
  document.getElementById("downloadCsvButton").addEventListener("click", downloadCsv);
}

// ===== 데이터 채우기 / 비우기 =====

function fillSampleData() {
  document.getElementById("branches").value   = ["강남", "일산", "다산"].join("\n");
  document.getElementById("procedures").value = ["울쎄라", "인모드", "리쥬란"].join("\n");
  document.getElementById("keywords").value   = ["효과", "추천", "부작용", "유지기간"].join("\n");

  syncStateFromAllTextareas();
  updateResult();
  setStatus("예시 데이터를 채워 두었어요. 아래 미리보기에서 조합 결과를 먼저 확인해 보세요.");
}

function clearAll() {
  Object.values(sourceConfig).forEach((config) => {
    document.getElementById(config.textareaId).value = "";
    updateFileName(config, "선택한 파일 없음");
  });

  state.branches     = [];
  state.procedures   = [];
  state.keywords     = [];
  state.results      = [];
  state.activeLabels = [];
  updateCountsOnly();
  resetPreview();
  setStatus("입력한 내용을 모두 비웠어요.");
}

// ===== 상태 동기화 =====

function syncStateFromAllTextareas() {
  Object.values(sourceConfig).forEach((config) => {
    updateStateFromTextarea(config);
  });
}

function updateStateFromTextarea(config) {
  const textarea = document.getElementById(config.textareaId);
  const key = getSourceKeyFromTextareaId(config.textareaId);
  state[key] = tokenizeValues(textarea.value);
}

function getSourceKeyFromTextareaId(textareaId) {
  return Object.keys(sourceConfig).find((key) => sourceConfig[key].textareaId === textareaId);
}

// ===== 토크나이징 / 중복 제거 =====

function tokenizeValues(rawText) {
  const seen = new Set();
  const values = String(rawText ?? "")
    .replace(/^﻿/, "")
    .split(/[,\n;\t]+/g)
    .map((value) => value.trim())
    .filter(Boolean);

  return values.filter((value) => {
    const normalized = value.toLocaleLowerCase("ko-KR");
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

// ===== 파일 읽기 =====

async function readValuesFromFile(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();

  if (extension === "txt" || extension === "md") {
    const text = await file.text();
    return tokenizeValues(text);
  }

  if (extension === "csv") {
    const text = await file.text();
    return readValuesFromCsv(text);
  }

  if (extension === "xlsx") {
    if (!state.xlsxReady || !window.XLSX) {
      throw new Error("엑셀 기능을 불러오지 못했어요. 새로고침 후 다시 시도하거나 CSV 파일을 사용해 주세요.");
    }

    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
      return [];
    }

    const sheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
    const firstColumnValues = [];

    for (let index = 1; index < rows.length; index += 1) {
      const cellValue = rows[index]?.[0];
      if (cellValue !== undefined && cellValue !== null && String(cellValue).trim()) {
        firstColumnValues.push(String(cellValue).trim());
      }
    }

    if (firstColumnValues.length > 0) {
      return dedupeValues(firstColumnValues);
    }

    const fallbackValues = rows
      .flat()
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);

    return dedupeValues(fallbackValues);
  }

  throw new Error("지원하지 않는 파일 형식이에요. txt, md, csv, xlsx 파일을 사용해 주세요.");
}

function readValuesFromCsv(text) {
  const normalizedText = String(text ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const rows = normalizedText
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseCsvLine);

  if (!rows.length) {
    return [];
  }

  const firstColumnValues = rows
    .slice(1)
    .map((row) => String(row[0] ?? "").trim())
    .filter(Boolean);

  if (firstColumnValues.length > 0) {
    return dedupeValues(firstColumnValues);
  }

  const fallbackValues = rows
    .flat()
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  return dedupeValues(fallbackValues);
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells;
}

function dedupeValues(values) {
  const seen = new Set();
  return values.filter((value) => {
    const normalized = value.toLocaleLowerCase("ko-KR");
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

// ===== 카운트 / 버튼 전용 업데이트 (입력 중 실시간) =====

function updateCountsOnly() {
  syncStateFromAllTextareas();
  updateCounts();
  updateButtons();
}

function updateCounts() {
  Object.entries(sourceConfig).forEach(([key, config]) => {
    const count = state[key].length;
    document.getElementById(config.badgeId).textContent = `${count.toLocaleString("ko-KR")}개`;
    document.getElementById(config.heroCountId).textContent = count.toLocaleString("ko-KR");
  });

  document.getElementById("totalCount").textContent = getTotalCount().toLocaleString("ko-KR");
}

function getTotalCount() {
  const active = getActiveSources();
  if (active.length === 0) {
    return 0;
  }
  return active.reduce((product, s) => product * s.values.length, 1);
}

function updateButtons() {
  const hasActiveSource = getActiveSources().length > 0;
  const hasResults = state.results.length > 0;

  document.getElementById("combineButton").disabled = !hasActiveSource;
  document.getElementById("downloadXlsxButton").disabled = !hasResults || !state.xlsxReady;
  document.getElementById("downloadCsvButton").disabled = !hasResults;
}

// ===== 결과 생성 (조합하기 버튼 클릭 시) =====

function updateResult() {
  const active = getActiveSources();
  const rows = buildRows(active);

  state.results      = rows;
  state.activeLabels = active.map((s) => s.label);

  updateButtons();
  updatePreview(rows);
}

function buildRows(activeSources) {
  if (activeSources.length === 0) {
    return [];
  }

  const valueArrays = activeSources.map((s) => s.values);
  const combinations = cartesianProduct(valueArrays);

  return combinations.map((combo) => {
    const combined = combo.join(" ").trim();
    return [...combo, combined];
  });
}

function updatePreview(rows) {
  const previewBody = document.getElementById("previewBody");
  const previewMeta = document.getElementById("previewMeta");

  if (!rows.length) {
    resetPreview();
    return;
  }

  const slicedRows = rows.slice(0, previewLimit);
  // 마지막 열이 조합 키워드이므로 그것만 미리보기에 표시
  previewBody.innerHTML = slicedRows
    .map(
      (row, index) => `
        <tr>
          <td class="col-num">${(index + 1).toLocaleString("ko-KR")}</td>
          <td>${escapeHtml(row[row.length - 1])}</td>
        </tr>
      `,
    )
    .join("");

  if (rows.length > previewLimit) {
    previewMeta.textContent = `전체 ${rows.length.toLocaleString("ko-KR")}개 중 처음 ${slicedRows.length.toLocaleString("ko-KR")}개를 보여드리고 있어요. 전체는 엑셀 또는 CSV로 저장해서 확인하세요.`;
  } else {
    previewMeta.textContent = `총 ${rows.length.toLocaleString("ko-KR")}개의 조합 키워드입니다.`;
  }
}

function resetPreview() {
  const previewBody = document.getElementById("previewBody");
  const previewMeta = document.getElementById("previewMeta");
  previewBody.innerHTML = '<tr><td colspan="2" class="empty">값을 입력하고 \'조합하기\'를 눌러보세요.</td></tr>';
  previewMeta.textContent = "아직 만들어진 결과가 없어요.";
}

// ===== 스프레드시트 UI =====

function updateSpreadsheetUi() {
  const xlsxButton = document.getElementById("downloadXlsxButton");

  if (!state.xlsxReady) {
    xlsxButton.title = "엑셀 기능을 불러오지 못해 현재 사용할 수 없습니다.";
    setStatus("엑셀 기능 연결이 불안정해 현재는 TXT·CSV 불러오기와 CSV 저장은 정상 사용 가능합니다. 엑셀 저장이나 XLSX 업로드가 필요하면 새로고침 후 다시 확인해 주세요.", true);
    return;
  }

  xlsxButton.title = "";
}

// ===== 다운로드 =====

function getDownloadHeader() {
  return ["순번", ...state.activeLabels, "조합 키워드"];
}

function downloadXlsx() {
  const rows = state.results;
  if (!rows.length) {
    setStatus("저장할 결과가 없어요. 먼저 '조합하기'를 눌러주세요.", true);
    return;
  }

  if (!state.xlsxReady || !window.XLSX) {
    setStatus("엑셀 저장 기능을 불러오지 못했어요. CSV 저장을 이용해 주세요.", true);
    return;
  }

  const numberedRows = rows.map((row, i) => [i + 1, ...row]);
  const worksheet = XLSX.utils.aoa_to_sheet([getDownloadHeader(), ...numberedRows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "CombinedKeywords");
  XLSX.writeFile(workbook, buildFileName("xlsx"));
  setStatus(`엑셀 파일로 저장했어요. 총 ${rows.length.toLocaleString("ko-KR")}개입니다.`);
}

function downloadCsv() {
  const rows = state.results;
  if (!rows.length) {
    setStatus("저장할 결과가 없어요. 먼저 '조합하기'를 눌러주세요.", true);
    return;
  }

  const numberedRows = rows.map((row, i) => [i + 1, ...row]);
  const csvRows = [getDownloadHeader(), ...numberedRows];
  const csvContent = csvRows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
  const blob = new Blob(["﻿", csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = buildFileName("csv");
  link.click();
  URL.revokeObjectURL(url);
  setStatus(`CSV 파일로 저장했어요. 총 ${rows.length.toLocaleString("ko-KR")}개입니다.`);
}

// ===== 유틸 =====

function buildFileName(extension) {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `combined-keywords-${timestamp}.${extension}`;
}

function escapeCsv(value) {
  const stringValue = String(value ?? "");
  return `"${stringValue.replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function updateFileName(config, fileName) {
  const target = document.getElementById(config.fileNameId);
  target.textContent = fileName;
}

function setStatus(message, isError = false) {
  const statusMessage = document.getElementById("statusMessage");
  statusMessage.textContent = message;
  statusMessage.dataset.tone = isError ? "error" : "default";
}
