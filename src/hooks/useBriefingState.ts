import { useState, useReducer } from 'react';

interface BriefingState {
  outputs: any[];
  selectedOutput: any | null;
  articles: any[];
  previewArticle: any | null;
  loading: boolean;
  sending: boolean;
  downloadingFormat: 'pdf' | 'html' | null;
  sharing: boolean;
  shareUrl: string;
  actionMessage: string | null;
  regenModalOpen: boolean;
  regenPrompt: string;
  regenerating: boolean;
  editMode: boolean;
  savingEdit: boolean;
  currentTemplates: { internal?: string; external?: string };
  settingTemplate: boolean;
  emailModalOpen: boolean;
  distGroups: any[];
  selectedGroupIds: string[];
  unsubscribes: Set<string>;
  emailSendStatus: string;
}

type BriefingAction = 
  | { type: 'SET_OUTPUTS'; payload: any[] }
  | { type: 'SET_SELECTED_OUTPUT'; payload: any | null }
  | { type: 'SET_ARTICLES'; payload: any[] }
  | { type: 'SET_PREVIEW_ARTICLE'; payload: any | null }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ACTION_MESSAGE'; payload: string | null }
  | { type: 'UPDATE_STATE'; payload: Partial<BriefingState> };

function reducer(state: BriefingState, action: BriefingAction): BriefingState {
  switch (action.type) {
    case 'SET_OUTPUTS': return { ...state, outputs: action.payload };
    case 'SET_SELECTED_OUTPUT': return { ...state, selectedOutput: action.payload };
    case 'SET_ARTICLES': return { ...state, articles: action.payload };
    case 'SET_PREVIEW_ARTICLE': return { ...state, previewArticle: action.payload };
    case 'SET_LOADING': return { ...state, loading: action.payload };
    case 'SET_ACTION_MESSAGE': return { ...state, actionMessage: action.payload };
    case 'UPDATE_STATE': return { ...state, ...action.payload };
    default: return state;
  }
}

const initialState: BriefingState = {
  outputs: [],
  selectedOutput: null,
  articles: [],
  previewArticle: null,
  loading: true,
  sending: false,
  downloadingFormat: null,
  sharing: false,
  shareUrl: '',
  actionMessage: null,
  regenModalOpen: false,
  regenPrompt: '',
  regenerating: false,
  editMode: false,
  savingEdit: false,
  currentTemplates: {},
  settingTemplate: false,
  emailModalOpen: false,
  distGroups: [],
  selectedGroupIds: [],
  unsubscribes: new Set(),
  emailSendStatus: ''
};

export function useBriefingState() {
  const [state, dispatch] = useReducer(reducer, initialState);

  return {
    state,
    dispatch,
    setOutputs: (payload: any[]) => dispatch({ type: 'SET_OUTPUTS', payload }),
    setSelectedOutput: (payload: any | null) => dispatch({ type: 'SET_SELECTED_OUTPUT', payload }),
    setArticles: (payload: any[]) => dispatch({ type: 'SET_ARTICLES', payload }),
    setPreviewArticle: (payload: any | null) => dispatch({ type: 'SET_PREVIEW_ARTICLE', payload }),
    setLoading: (payload: boolean) => dispatch({ type: 'SET_LOADING', payload }),
    setActionMessage: (payload: string | null) => dispatch({ type: 'SET_ACTION_MESSAGE', payload }),
    updateState: (payload: Partial<BriefingState>) => dispatch({ type: 'UPDATE_STATE', payload })
  };
}
