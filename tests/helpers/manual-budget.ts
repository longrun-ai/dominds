import { renderToolsetManual } from '../../main/tools/manual/render';
import { renderTeamMgmtGuideContent } from '../../main/tools/team_mgmt-manual';

/** The build budget must inspect original prose, before the runtime substitutes its size notice. */
export async function rawManualForBudget(input: {
  toolsetId: string;
  language: 'en' | 'zh';
  topic?: string;
  topics?: readonly string[];
}): Promise<string> {
  if (input.toolsetId === 'team_mgmt') {
    return renderTeamMgmtGuideContent(
      input.language,
      input.topics ?? (input.topic ? [input.topic] : []),
    );
  }
  const result = renderToolsetManual({
    toolsetId: input.toolsetId,
    language: input.language,
    request: { requestedTopic: input.topic, requestedTopics: input.topics },
  });
  if (!result.foundToolset)
    throw new Error(`Unregistered budget-check toolset: ${input.toolsetId}`);
  return result.content;
}
