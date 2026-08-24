/**
 * panas-prompt.js
 * Shared PANAS (Positive and Negative Affect Schedule) prompt text, item lists,
 * and response parsing, so every VLM provider module reuses identical scoring
 * semantics.
 */

const PANAS_POSITIVE = [
  'interested', 'excited', 'strong', 'enthusiastic', 'proud',
  'alert', 'inspired', 'determined', 'attentive', 'active'
];
const PANAS_NEGATIVE = [
  'distressed', 'upset', 'guilty', 'scared', 'hostile',
  'irritable', 'ashamed', 'nervous', 'jittery', 'afraid'
];

const PANAS_PROMPT = `You are an expert environmental psychologist conducting a PANAS (Positive and Negative Affect Schedule) assessment of urban/outdoor environments.

Simulate the average results of 20 typical people that look at this image and rate how this environment would make them feel. For each PANAS item, provide an average score from 1 to 5:

Respond with ONLY a valid JSON object in this exact format, no explanation:
{
  "interested": float <1-5>,
  "excited":  float <1-5>,
  "strong":  float <1-5>,
  "enthusiastic": float <1-5>,
  "proud": float <1-5>,
  "alert": float <1-5>,
  "inspired": float <1-5>,
  "determined": float <1-5>,
  "attentive": float <1-5>,
  "active": float <1-5>,
  "distressed": float <1-5>,
  "upset": float <1-5>,
  "guilty": float <1-5>,
  "scared": float <1-5>,
  "hostile": float <1-5>,
  "irritable": float <1-5>,
  "ashamed": float <1-5>,
  "nervous": float <1-5>,
  "jittery": float <1-5>,
  "afraid": float <1-5>
}`;

/**
 * Parse a raw text response from a VLM into PANAS scores + aggregates.
 * @param {string} responseText
 */
function parsePANASResponse(responseText) {
  let jsonStr = (responseText || '').trim();
  
  // Attempt to extract from explicit markdown code block first
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1];
  } else {
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];
  }

  // Remove common open-source syntax errors like trailing commas before closing braces
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

  let scores;
  try {
    scores = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Failed to parse PANAS response as JSON: ${responseText.substring(0, 400)}`);
  }

  const positiveScore = PANAS_POSITIVE.reduce((sum, item) => sum + (scores[item] || 0), 0);
  const negativeScore = PANAS_NEGATIVE.reduce((sum, item) => sum + (scores[item] || 0), 0);

  const result = {
    interested: scores.interested,
    excited: scores.excited,
    strong: scores.strong,
    enthusiastic: scores.enthusiastic,
    proud: scores.proud,
    alert: scores.alert,
    inspired: scores.inspired,
    determined: scores.determined,
    attentive: scores.attentive,
    active: scores.active,
    distressed: scores.distressed,
    upset: scores.upset,
    guilty: scores.guilty,
    scared: scores.scared,
    hostile: scores.hostile,
    irritable: scores.irritable,
    ashamed: scores.ashamed,
    nervous: scores.nervous,
    jittery: scores.jittery,
    afraid: scores.afraid,
    positive_affect_score: positiveScore,
    negative_affect_score: negativeScore,
    net_affect_score: positiveScore - negativeScore,
    brief_description: scores.brief_description || '',
  };

  return result;
}

module.exports = { PANAS_POSITIVE, PANAS_NEGATIVE, PANAS_PROMPT, parsePANASResponse };
