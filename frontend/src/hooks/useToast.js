import { useState, useCallback } from "react";

function useToast(){
  const [toasts,setToasts]=useState([]);
  const add=useCallback((message,type="info")=>{
    const id=Date.now();
    setToasts(p=>[...p,{id,message,type}]);
    setTimeout(()=>setToasts(p=>p.filter(t=>t.id!==id)),4000);
  },[]);
  const remove=useCallback(id=>setToasts(p=>p.filter(t=>t.id!==id)),[]);
  return {toasts,addToast:add,removeToast:remove};
}

export default useToast
