import { defineStore } from 'pinia';
import { ref } from 'vue';
import { historyApi } from '../api/history';
import { assetsApi } from '../api/assets';
import { skillsApi } from '../api/skills';
import type { SearchResult, SearchType } from '../types/search';

export const useSearchStore = defineStore('search', () => {
  const query = ref('');
  const results = ref<SearchResult[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const isOpen = ref(false);
  const pagination = ref({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  });
  const searchType = ref<SearchType | 'all'>('all');

  async function search(searchQuery: string, page = 1) {
    if (!searchQuery.trim()) {
      results.value = [];
      return;
    }

    query.value = searchQuery;
    loading.value = true;
    error.value = null;

    try {
      // 并行搜索会话和资产；任一旁支失败不影响主线（会话）结果
      const [sessionSettled, agentsSettled, commandsSettled, skillsSettled] =
        await Promise.allSettled([
          historyApi.search(searchQuery, page, pagination.value.pageSize),
          assetsApi.getAgents(),
          assetsApi.getCommands(),
          skillsApi.getTree('global'),
        ]);

      const sessionResponse =
        sessionSettled.status === 'fulfilled' ? sessionSettled.value : null;
      const agents = agentsSettled.status === 'fulfilled' ? agentsSettled.value : [];
      const commands =
        commandsSettled.status === 'fulfilled' ? commandsSettled.value : [];
      // skills 接口返回 { tree: SkillTreeNode }，根节点是分类包装，真正可搜的是 children
      const skills =
        skillsSettled.status === 'fulfilled'
          ? skillsSettled.value?.tree?.children ?? []
          : [];

      const allResults: SearchResult[] = [];

      // 添加会话结果
      if (sessionResponse && (searchType.value === 'all' || searchType.value === 'session')) {
        allResults.push(
          ...sessionResponse.data.map((r) => ({ ...r, type: 'session' as SearchType })),
        );
      }

      // 搜索 Agents
      if (searchType.value === 'all' || searchType.value === 'agent') {
        const agentResults = searchInAssets(agents, searchQuery, 'agent');
        allResults.push(...agentResults);
      }

      // 搜索 Commands
      if (searchType.value === 'all' || searchType.value === 'command') {
        const commandResults = searchInAssets(commands, searchQuery, 'command');
        allResults.push(...commandResults);
      }

      // 搜索 Skills
      if (searchType.value === 'all' || searchType.value === 'skill') {
        const skillResults = searchInSkills(skills, searchQuery);
        allResults.push(...skillResults);
      }

      // 按相关性排序
      results.value = allResults.sort((a, b) => b.rank - a.rank).slice(0, 50);
      const sessionTotal = sessionResponse?.pagination.total ?? 0;
      const sessionCount = sessionResponse?.data.length ?? 0;
      pagination.value = {
        page: sessionResponse?.pagination.page ?? page,
        pageSize: sessionResponse?.pagination.pageSize ?? pagination.value.pageSize,
        totalPages: sessionResponse?.pagination.totalPages ?? 0,
        total: sessionTotal + allResults.length - sessionCount,
      };
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Search failed';
    } finally {
      loading.value = false;
    }
  }

  function searchInAssets(assets: any[], searchQuery: string, type: SearchType): SearchResult[] {
    const lowerQuery = searchQuery.toLowerCase();
    return assets
      .filter(asset =>
        asset.name?.toLowerCase().includes(lowerQuery) ||
        asset.description?.toLowerCase().includes(lowerQuery)
      )
      .map((asset, index) => ({
        id: Date.now() + index,
        session_id: '',
        title: asset.name,
        project_path: '',
        snippet: asset.description || '',
        rank: 0.8,
        type,
        assetId: asset.id,
        assetCategory: asset.category,
      }));
  }

  function searchInSkills(skills: any[], searchQuery: string): SearchResult[] {
    const lowerQuery = searchQuery.toLowerCase();
    const results: SearchResult[] = [];

    function searchRecursive(items: any[], category = '') {
      for (const skill of items) {
        const skillName = skill.name || skill.id || '';
        const skillDesc = skill.description || '';

        if (skillName.toLowerCase().includes(lowerQuery) ||
            skillDesc.toLowerCase().includes(lowerQuery)) {
          results.push({
            id: Date.now() + Math.random(),
            session_id: '',
            title: skillName,
            project_path: '',
            snippet: skillDesc,
            rank: 0.7,
            type: 'skill',
            assetId: skill.id || skillName,
            assetCategory: category,
          });
        }

        if (skill.children) {
          searchRecursive(skill.children, skillName);
        }
      }
    }

    searchRecursive(skills);
    return results;
  }

  function setSearchType(type: SearchType | 'all') {
    searchType.value = type;
  }

  function openSearch() {
    isOpen.value = true;
  }

  function closeSearch() {
    isOpen.value = false;
  }

  function clearResults() {
    results.value = [];
    query.value = '';
    pagination.value = {
      page: 1,
      pageSize: 20,
      total: 0,
      totalPages: 0,
    };
  }

  return {
    query,
    results,
    loading,
    error,
    isOpen,
    pagination,
    searchType,
    search,
    setSearchType,
    openSearch,
    closeSearch,
    clearResults,
  };
});
