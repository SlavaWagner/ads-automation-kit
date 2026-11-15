import { AccountExplorerAgent } from './mcp/AccountExplorerAgent.js';
import { CampaignAgent } from './mcp/CampaignAgent.js';
import { AdGroupAgent } from './mcp/AdGroupAgent.js';
import { AdCreativeAgent } from './mcp/AdCreativeAgent.js';
import { PMaxAssetGroupAgent } from './mcp/PMaxAssetGroupAgent.js';
import { KeywordAgent } from './mcp/KeywordAgent.js';
import { SearchTermAgent } from './mcp/SearchTermAgent.js';
import { ChangeHistoryListenerAgent } from './mcp/ChangeHistoryListenerAgent.js';
import { AudienceAgent } from './mcp/AudienceAgent.js';
import { PlacementAgent } from './mcp/PlacementAgent.js';
import { LocationGeoAgent } from './mcp/LocationGeoAgent.js';
import { BiddingBudgetAgent } from './mcp/BiddingBudgetAgent.js';
import { DaypartingScheduleAgent } from './mcp/DaypartingScheduleAgent.js';
import { AssetExtensionsAgent } from './mcp/AssetExtensionsAgent.js';
import { ConversionAttributionAgent } from './mcp/ConversionAttributionAgent.js';
import { RecommendationsAgent } from './mcp/RecommendationsAgent.js';

import { AngleDiscoveryAgent } from './rd/AngleDiscoveryAgent.js';
import { AiAssetGeneratorAgent } from './rd/AiAssetGeneratorAgent.js';
import { AssetTestingAgent } from './rd/AssetTestingAgent.js';
import { AssetIntelligenceAgent } from './rd/AssetIntelligenceAgent.js';
import { BudgetScalingAgent } from './rd/BudgetScalingAgent.js';
import { SearchTermIntelAgent } from './rd/SearchTermIntelAgent.js';
import { AnomalyHealthAgent } from './rd/AnomalyHealthAgent.js';
import { FormatPlacementAgent } from './rd/FormatPlacementAgent.js';
import { PredictiveForecastAgent } from './rd/PredictiveForecastAgent.js';

export function createAgentInstances() {
  return [
    // 16 Paired MCP Domain Agents (Sequence 01-16: Setup -> Structure -> Demand -> Creatives -> Targeting -> Bidding -> Conversions -> Audit)
    new AccountExplorerAgent(),
    new CampaignAgent(),
    new AdGroupAgent(),
    new KeywordAgent(),
    new SearchTermAgent(),
    new AdCreativeAgent(),
    new PMaxAssetGroupAgent(),
    new AssetExtensionsAgent(),
    new AudienceAgent(),
    new PlacementAgent(),
    new LocationGeoAgent(),
    new BiddingBudgetAgent(),
    new DaypartingScheduleAgent(),
    new ConversionAttributionAgent(),
    new RecommendationsAgent(),
    new ChangeHistoryListenerAgent(),

    // 9 Sequential R&D Intelligence Agents (Stages 1-9: Angles -> Generation -> Testing -> Creative Audit -> Intent -> Scaling -> Yield -> Anomalies -> Forecasting)
    new AngleDiscoveryAgent(),
    new AiAssetGeneratorAgent(),
    new AssetTestingAgent(),
    new AssetIntelligenceAgent(),
    new SearchTermIntelAgent(),
    new BudgetScalingAgent(),
    new FormatPlacementAgent(),
    new AnomalyHealthAgent(),
    new PredictiveForecastAgent()
  ];
}

export class AgentRegistry {
  constructor() {
    this.agents = new Map();
    for (const agent of createAgentInstances()) {
      this.agents.set(agent.id, agent);
    }
  }

  get(id) {
    return this.agents.get(id);
  }

  has(id) {
    return this.agents.has(id);
  }

  list(group = 'ALL') {
    const all = Array.from(this.agents.values());
    if (!group || group === 'ALL') return all;
    return all.filter((a) => a.group === group);
  }

  describeAll() {
    return Array.from(this.agents.values()).map((a) => a.getDescriptor());
  }
}

export function createAgentRegistry() {
  return new AgentRegistry();
}
