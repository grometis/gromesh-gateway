import {useEffect,useRef} from 'react';

/** A local search shortcut never consumes typing, browser shortcuts or an open dialog. */
export function useSearchShortcut(){
 const ref=useRef<HTMLInputElement>(null);
 useEffect(()=>{
  const keydown=(event:KeyboardEvent)=>{
   if(event.defaultPrevented||event.key!=='/'||event.ctrlKey||event.metaKey||event.altKey||document.querySelector('[role="dialog"],dialog[open]'))return;
   const target=event.target;
   if(target instanceof HTMLElement&&(target.isContentEditable||target.closest('input,textarea,select,[contenteditable="true"]')))return;
   if(!ref.current||ref.current.disabled)return;
   event.preventDefault();ref.current.focus();
  };
  document.addEventListener('keydown',keydown);return()=>document.removeEventListener('keydown',keydown);
 },[]);
 return ref;
}
