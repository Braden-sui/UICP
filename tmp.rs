use anyhow::{Context, anyhow};
fn main(){
 let err = anyhow!("inner").context("outer");
 println!("{}", err);
}
