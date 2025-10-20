#![cfg_attr(not(feature = "std"), no_std)]

// WHY: Re-export fast_float2 APIs under the fast_float crate name to pick up memory safety fixes.
pub use fast_float2::*;
