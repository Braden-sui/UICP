use std::collections::HashMap;

use secrecy::{ExposeSecret, SecretString};

use crate::keystore::{get_or_init_keystore, KeystoreError};

/// Map provider -> (service, account) used to fetch the secret from keystore.
fn provider_secret_id(provider: &str) -> Option<(&'static str, &'static str)> {
    match provider.to_ascii_lowercase().as_str() {
        // service "uicp" is our internal namespace; account encodes provider:key kind
        "openai" => Some(("uicp", "openai:api_key")),
        "anthropic" => Some(("uicp", "anthropic:api_key")),
        "openrouter" => Some(("uicp", "openrouter:api_key")),
        "ollama" => Some(("uicp", "ollama:api_key")),
        _ => None,
    }
}

/// Build provider-specific Authorization headers inside the backend only.
/// UI never sees plaintext secrets.
pub async fn build_provider_headers(provider: &str) -> Result<HashMap<String, String>, KeystoreError> {
    let Some((service, account)) = provider_secret_id(provider) else {
        return Err(KeystoreError::Other(format!("unknown provider: {provider}")));
    };
    let ks = get_or_init_keystore().await?;
    let secret = ks.read_internal(service, account).await?; // SecretVec<u8>
    let key = String::from_utf8(secret.expose_secret().clone())
        .map_err(|_| KeystoreError::Crypto("provider key is not valid UTF-8".into()))?;

    let mut headers = HashMap::new();
    match provider.to_ascii_lowercase().as_str() {
        "openai" => {
            headers.insert("Authorization".into(), format!("Bearer {key}"));
        }
        "anthropic" => {
            headers.insert("x-api-key".into(), key);
        }
        "openrouter" => {
            headers.insert("Authorization".into(), format!("Bearer {key}"));
            headers.insert("X-Title".into(), "UICP".into());
        }
        "ollama" => {
            headers.insert("Authorization".into(), format!("Bearer {key}"));
        }
        _ => unreachable!(),
    }
    Ok(headers)
}
