export interface AiConfig {
  api_key: string;
  base_url?: string;
  model_name: string;
}

export interface ConfigSaveResult {
  success: boolean;
  message: string;
}

export interface ModelListResult {
  success: boolean;
  message: string;
  models: string[];
}
