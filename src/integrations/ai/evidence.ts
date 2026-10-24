import type { KnowledgeSnapshot, ScanResults } from './contracts';
import { AIServiceError } from './client';

/** Provider references are accepted only against the exact published snapshot sent. */
export function validateResults(results: ScanResults, snapshot: KnowledgeSnapshot, body: string) {
  const sources = new Map<string, { text: string; type: string }>();
  if (snapshot.brandProfile) sources.set(snapshot.brandProfile.id, { text: [snapshot.brandProfile.name, snapshot.brandProfile.voice, snapshot.brandProfile.tone, snapshot.brandProfile.audience, snapshot.brandProfile.description].join('\n'), type: 'brandProfile' });
  for (const item of snapshot.guidelines) sources.set(item.id, { text: item.description, type: 'guideline' });
  for (const item of snapshot.approvedFacts) sources.set(item.id, { text: item.statement, type: 'approvedFact' });
  for (const item of snapshot.terminologyRules) sources.set(item.id, { text: [item.term, item.replacement, item.description].join('\n'), type: 'terminologyRule' });
  const chunks = new Map(snapshot.chunks.map(chunk => [chunk.id, chunk]));
  const documentIds = new Set(snapshot.chunks.map(chunk => chunk.documentId));
  const externalIds = new Set<string>();
  const invalid = () => { throw new AIServiceError('AI_UNTRUSTED_RESULT', false); };
  const splitsSurrogatePair = (offset: number) => offset > 0 && offset < body.length && body.charCodeAt(offset - 1) >= 0xd800 && body.charCodeAt(offset - 1) <= 0xdbff && body.charCodeAt(offset) >= 0xdc00 && body.charCodeAt(offset) <= 0xdfff;
  for (const finding of results.findings) {
    if (externalIds.has(finding.id)) invalid();
    externalIds.add(finding.id);
    if ((finding.start === undefined) !== (finding.end === undefined)) invalid();
    if (finding.start !== undefined && finding.end !== undefined && (finding.end <= finding.start || finding.end > body.length || splitsSurrogatePair(finding.start) || splitsSurrogatePair(finding.end))) invalid();
    if (finding.ruleId) {
      const source = sources.get(finding.ruleId);
      if (finding.ruleType === 'document' ? !documentIds.has(finding.ruleId) : !source || (finding.ruleType && source.type !== finding.ruleType)) invalid();
    } else if (finding.ruleType) invalid();
    for (const evidence of finding.evidence) {
      let sourceText: string | undefined;
      if (evidence.chunkId) {
        const chunk = chunks.get(evidence.chunkId);
        if (!chunk || chunk.documentId !== evidence.sourceId) invalid();
        sourceText = chunk?.text;
      } else sourceText = sources.get(evidence.sourceId)?.text;
      if (!sourceText || !sourceText.includes(evidence.quote)) invalid();
      if ((evidence.start === undefined) !== (evidence.end === undefined)) invalid();
      if (evidence.start !== undefined && evidence.end !== undefined && (evidence.end <= evidence.start || sourceText?.slice(evidence.start, evidence.end) !== evidence.quote)) invalid();
    }
  }
  return results;
}
