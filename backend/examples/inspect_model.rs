fn main()->Result<(),Box<dyn std::error::Error>> {
    let runtime=if cfg!(windows){".tools/onnxruntime/onnxruntime-win-x64-1.22.0/lib/onnxruntime.dll"}else{"libonnxruntime.so"};
    ort::init_from(runtime).commit()?;
    let mut session=ort::session::Session::builder()?.with_intra_threads(1)?.commit_from_file("models/clap-audio-int8.onnx")?;
    for input in &session.inputs{println!("input {} {:?}",input.name,input.input_type);}
    for output in &session.outputs{println!("output {} {:?}",output.name,output.output_type);}
    let tensor=ort::value::Tensor::from_array(([1usize,1,1001,64],vec![-100f32;1001*64]))?;
    let output=session.run(ort::inputs!["input_features"=>tensor])?;
    for (name,value) in output.iter(){let (shape,values)=value.try_extract_tensor::<f32>()?;println!("result {name} {shape:?} values={} finite={}",values.len(),values.iter().all(|v|v.is_finite()));}
    Ok(())
}
