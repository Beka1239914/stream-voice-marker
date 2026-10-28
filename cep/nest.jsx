/* Experimental: one native nested clip per original track, linked as a moment. */
$._SVMNestBlock = function(sequenceId,block) {
    var seq=app.project.activeSequence,TPS=254016000000,oldIn,oldOut;
    function scan(s,a,b) {
        var rows=[],groups=[s.videoTracks,s.audioTracks];
        for(var g=0;g<2;g++)for(var t=0;t<groups[g].numTracks;t++) {
            var track=groups[g][t];
            for(var i=0;i<track.clips.numItems;i++) {
                var c=track.clips[i],start=Number(c.start.ticks),end=Number(c.end.ticks);
                if(end<=a+1||start>=b-1)continue;
                if(start<a-1||end>b+1)throw new Error('Клип пересекает границу цельного блока. Упаковка остановлена.');
                if(track.isLocked())throw new Error('Дорожка заблокирована.');
                rows.push({clip:c,kind:g,track:t,start:start,end:end,inp:c.inPoint.ticks,out:c.outPoint.ticks,components:c.components.numItems});
            }
        }
        return rows;
    }
    try {
        if(!seq||seq.sequenceID!==sequenceId)throw new Error('Откройте обрабатываемый эпизод.');
        if(!block||!isFinite(block.start)||!isFinite(block.end)||block.start<0||block.end<=block.start||block.start!==Math.floor(block.start)||block.end!==Math.floor(block.end))throw new Error('Неверные границы блока.');
        var a=block.start*Number(seq.timebase),b=block.end*Number(seq.timebase),rows=scan(seq,a,b);
        var v=-1,au=-1,i;
        for(i=0;i<rows.length;i++) {
            if(rows[i].kind===0&&(v<0||rows[i].track<v))v=rows[i].track;
            if(rows[i].kind===1&&(au<0||rows[i].track<au))au=rows[i].track;
        }
        if(v<0||au<0)throw new Error('Для цельного блока нужны видео и звук.');
        var layers=[],map={},trackGroups=[seq.videoTracks,seq.audioTracks],scratch=[-1,-1],g,t,j;
        for(i=0;i<rows.length;i++) {
            var key=rows[i].kind+'_'+rows[i].track;
            if(!map[key]){map[key]={kind:rows[i].kind,track:rows[i].track,rows:[]};layers.push(map[key]);}
            map[key].rows.push(rows[i]);
        }
        // Premiere inserts both media types even from a video-only nested sequence.
        // Route the unwanted counterpart to a verified empty spare track, then remove it.
        for(g=0;g<2;g++)for(t=0;t<trackGroups[g].numTracks;t++) {
            var spare=trackGroups[g][t];
            if(!map[g+'_'+t]&&!spare.isLocked()&&spare.clips.numItems===0){scratch[g]=t;break;}
        }
        if(scratch[0]<0||scratch[1]<0)throw new Error('Для экспериментальной упаковки оставьте одну пустую разблокированную видео- и аудиодорожку.');
        oldIn=seq.getInPoint();oldOut=seq.getOutPoint();
        seq.setInPoint(a/TPS);seq.setOutPoint(b/TPS);
        for(var li=0;li<layers.length;li++) {
            var layer=layers[li],nested=seq.createSubsequence(true);
            if(!nested)throw new Error('Premiere не создал вложенный эпизод.');
            layer.nested=nested;
            nested.name='Jump Cut '+(layer.kind===0?'V':'A')+(layer.track+1)+' — блок '+(block.index+1)+' — '+new Date().getTime();
            var nts=[nested.videoTracks,nested.audioTracks];
            for(g=0;g<2;g++)for(t=0;t<nts[g].numTracks;t++)if(g!==layer.kind||t!==layer.track) {
                for(j=nts[g][t].clips.numItems-1;j>=0;j--)nts[g][t].clips[j].remove(false,true);
            }
            var copied=scan(nested,0,b-a);
            if(Math.abs(Number(nested.end)-(b-a))>1||copied.length!==layer.rows.length||nested.frameSizeHorizontal!==seq.frameSizeHorizontal||nested.frameSizeVertical!==seq.frameSizeVertical)throw new Error('Проверка слоя не прошла. Исходные фрагменты оставлены.');
            for(i=0;i<layer.rows.length;i++) {
                var r=layer.rows[i],c=copied[i];
                if(r.kind!==c.kind||r.track!==c.track||Math.abs(r.start-a-c.start)>1||Math.abs(r.end-a-c.end)>1||r.inp!==c.inp||r.out!==c.out||r.components!==c.components)throw new Error('Вложенный слой отличается от фрагментов. Исходные фрагменты оставлены.');
            }
        }
        app.project.openSequence(seq.sequenceID);
        // The verified subsequence remains recoverable even if insertion fails.
        for(i=rows.length-1;i>=0;i--)rows[i].clip.remove(false,true);
        for(li=0;li<layers.length;li++) {
            layer=layers[li];nested=layer.nested;
            var vi=layer.kind===0?layer.track:scratch[0],ai=layer.kind===1?layer.track:scratch[1];
            if(!seq.overwriteClip(nested.projectItem,String(a),vi,ai))throw new Error('Не удалось вставить слой. Его содержимое сохранено в '+nested.name);
            var unwanted=layer.kind===0?seq.audioTracks[ai]:seq.videoTracks[vi];
            for(i=unwanted.clips.numItems-1;i>=0;i--) {
                if(String(unwanted.clips[i].projectItem.nodeId)!==String(nested.projectItem.nodeId))throw new Error('На временной дорожке появился другой клип.');
                unwanted.clips[i].remove(false,true);
            }
        }
        var inserted=scan(seq,a,b),video=0,audio=0;
        var selection=seq.getSelection();for(i=0;i<selection.length;i++)selection[i].setSelected(false,false);
        for(i=0;i<inserted.length;i++) {
            var item=inserted[i];
            var expected=map[item.kind+'_'+item.track];
            if(!expected||String(item.clip.projectItem.nodeId)!==String(expected.nested.projectItem.nodeId)||Math.abs(item.start-a)>1||Math.abs(item.end-b)>1)throw new Error('Проверьте вставленный блок: границы отличаются.');
            if(item.kind===0)video++;else audio++;
            item.clip.setSelected(true,false);
        }
        if(inserted.length!==layers.length||video<1||audio<1)throw new Error('Не удалось сохранить отдельные слои блока.');
        seq.linkSelection();
        for(i=0;i<inserted.length;i++) {
            var linked=inserted[i].clip.getLinkedItems();
            if(!linked||linked.numItems!==inserted.length)throw new Error('Проверьте связь видео и аудио блока.');
            inserted[i].clip.setSelected(false,false);
        }
        return JSON.stringify({ok:true,video_layers:video,audio_layers:audio,linked:inserted.length});
    }catch(e){return JSON.stringify({error:String(e)});}
    finally {
        if(seq&&oldIn!==undefined) {
            // Premiere 25 has no Sequence.clearInPoint; -400000 is its unset sentinel.
            seq.setInPoint(Number(oldIn));seq.setOutPoint(Number(oldOut));
        }
    }
};
